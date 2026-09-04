/**
 * press — the Fly.io worker (U7).
 *
 * Everything that does not fit in a Vercel function lives here: the Raindrop
 * poll, extraction, layout, the weekly tick, and — since 017 — composing an
 * issue on demand. Chromium and multi-minute renders are the reason this is a
 * separate runtime (assumption 6 in the plan), and the reason the website asks
 * for a compose by writing a `press_jobs` row rather than doing it itself.
 *
 * The machine is stateless — all state is in Supabase — so it can be killed
 * and restarted at any point. Every step below is written to be resumable.
 *
 * This is the one runtime that legitimately sees everybody's press: it runs the
 * pipeline for every account, so it holds the unscoped service client and each
 * step carries the owner it is acting for. The exception is the Raindrop poll,
 * which runs on one person's token and so is scoped to that one person.
 */

/**
 * Every account's everything. Named `pressDbAsService` at its definition for
 * exactly this reason — a grep for it should find the four places that are
 * allowed to, and this is one of them.
 *
 * A function rather than a const because this module is imported by the tests
 * for `isWeeklyTick`, and building a client at import time turns a missing
 * SUPABASE_SERVICE_ROLE_KEY into a test suite that will not load. The client
 * itself is memoised, so calling this is free after the first time.
 */
const db = () => pressDbAsService()

import {
  failItem,
  getIssue,
  getItem,
  insertItem,
  itemsInState,
  issuesInState,
  pressDb,
  pressDbAsService,
  putObject,
  recordEvent,
  storagePath,
  updateItem,
  updateIssue,
} from '../src/lib/press/db'
import { ownerAccount } from '../src/lib/press/accounts'
import { loadSettings, missingSettings } from '../src/lib/press/settings'
import { pollRaindrops } from '../src/lib/press/raindrop'
import { extractFromUrl, extractFromNewsletterHtml, ExtractionError } from '../src/lib/press/extract'
import { classifyLinkpost, MAX_TARGETS, type OutboundLink } from '../src/lib/press/linkpost'
import { renderArticle } from '../src/lib/press/layout/render'
import { createLuluClient, isRejected, isShipped } from '../src/lib/press/lulu'
import { archiveIssue } from '../src/lib/press/archive'
import { refreshOrders } from '../src/lib/press/orders'
import { sendWeeklyDigest } from '../src/lib/press/digest'
import { getObject } from '../src/lib/press/db'
import { claimJob, reapStaleJobs } from '../src/lib/press/jobs'
import { runComposeJob } from '../src/lib/press/run-job'
import type { Article, LinkpostTarget, PressItem } from '../src/lib/press/types'

const SECOND = 1_000
const MINUTE = 60_000
const POLL_INTERVAL = 30 * MINUTE
const TICK_INTERVAL = 15 * MINUTE
/**
 * How often to look for work a button is waiting on.
 *
 * Ten seconds, not the poll's thirty minutes: somebody pressed "Make the PDF"
 * and is watching a progress line. One indexed lookup against a table with a
 * handful of rows is cheap enough to do six times a minute forever.
 */
const JOB_INTERVAL = 10 * SECOND

function log(step: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), step, ...detail }))
}

// ── Pipeline steps ───────────────────────────────────────────────────────────

/** queued → extracted. A failure here is recorded, never silent. */
async function extractQueued(): Promise<number> {
  const items = await itemsInState(['queued'], db(), 25)
  let done = 0

  const settings = loadSettings()

  for (const item of items) {
    try {
      let article: Article
      let links: OutboundLink[]
      if (item.source === 'newsletter') {
        if (!item.content_path) throw new ExtractionError('newsletter has no stored html', ['newsletter'])
        const html = new TextDecoder().decode(await getObject(item.content_path, db()))
        ;({ article, links } = await extractFromNewsletterHtml({
          itemId: item.id,
          html,
          senderName: item.source_name,
        }))
      } else {
        if (!item.url) throw new ExtractionError('item has no url', [])
        ;({ article, links } = await extractFromUrl({
          itemId: item.id,
          url: item.url,
          raindropId: item.raindrop_id,
        }))
      }

      // A piece a linkpost named says so on its own opener, so the relationship
      // survives into print rather than living only in the database.
      const parent = item.linkpost_parent_id ? await getItem(item.linkpost_parent_id, db()) : null
      if (parent) {
        article.linkpostOf = {
          title: parent.title ?? parent.url ?? 'a linkpost',
          url: parent.url,
          anchor: item.linkpost_anchor,
        }
      }

      // Only what was saved to `hw` is examined. A roundup reached *through* a
      // roundup is a rabbit hole, so anything that arrived this way is skipped
      // and the queue can never walk off down the web.
      const judgement = item.linkpost_parent_id
        ? null
        : await classifyLinkpost({
            article,
            links,
            apiKey: settings.anthropicApiKey,
            maxTargets: MAX_TARGETS,
          })

      if (judgement?.isLinkpost) {
        article.linkpost = {
          kind: judgement.kind,
          reason: judgement.reason,
          targets: judgement.targets,
        }
      }

      const path = storagePath.articleJson(item.id)
      await putObject(path, JSON.stringify(article), 'application/json', db())
      await updateItem(
        item.id,
        {
          state: 'extracted',
          content_path: path,
          title: article.title,
          byline: article.byline,
          source_name: article.sourceName ?? item.source_name,
          published_at: article.publishedAt ?? item.published_at,
          is_linkpost: Boolean(judgement?.isLinkpost),
          linkpost_scanned_at: new Date().toISOString(),
        },
        db(),
      )

      if (judgement?.isLinkpost) {
        const added = await queueLinkpostTargets(item, judgement.targets)
        log('linkpost', { item: item.id, named: judgement.targets.length, queued: added })
      }
      done++
    } catch (err) {
      await failItem(item.id, (err as Error).message, db())
    }
  }

  return done
}

/**
 * The pieces a linkpost named, queued as items of their own.
 *
 * `insertItem` upserts on `url_key` and returns null for a duplicate, so a link
 * already in the pipeline — saved to `hw` by hand, or named by two roundups in
 * the same week — is one article, and re-running this adds nothing.
 */
async function queueLinkpostTargets(
  parent: PressItem,
  targets: readonly LinkpostTarget[],
): Promise<number> {
  let added = 0
  for (const target of targets) {
    const inserted = await insertItem(
      {
        // The pieces a roundup names belong to whoever saved the roundup.
        // Taken from the parent rather than from a session, because nobody is
        // signed in here — the worker is acting on somebody's behalf, hours
        // after they went to bed.
        owner_id: parent.owner_id,
        source: 'raindrop',
        url: target.url,
        title: target.anchor || null,
        state: 'queued',
        linkpost_parent_id: parent.id,
        linkpost_anchor: target.anchor || null,
      },
      db(),
    )
    if (inserted) added++
  }
  return added
}

/**
 * extracted → laid_out. The measurement render (KTD7): its page count is what
 * drives the ≥100-page trigger. The fragment is a measurement, not shippable
 * pages — compose re-renders everything.
 */
async function layoutExtracted(): Promise<number> {
  const items = await itemsInState(['extracted'], db(), 25)
  let done = 0

  for (const item of items) {
    try {
      if (!item.content_path) throw new Error('extracted item has no article')
      const article = JSON.parse(
        new TextDecoder().decode(await getObject(item.content_path, db())),
      ) as Article
      const result = await renderArticle(article, {
        // A measurement render is thrown away — only its page count is kept —
        // and an item no longer belongs to an issue when it is measured, so
        // there is no issue number to put in the footer. Compose re-renders
        // every page with the real one.
        issueNumber: 0,
        startPage: 1,
        measurement: true,
      })
      const path = storagePath.fragment(item.id)
      await putObject(path, result.pdf, 'application/pdf', db())
      await updateItem(
        item.id,
        { state: 'laid_out', fragment_path: path, page_count: result.pageCount },
        db(),
      )
      done++
    } catch (err) {
      await failItem(item.id, `layout failed: ${(err as Error).message}`, db())
    }
  }

  return done
}

// assignToOpenIssue used to live here: laid_out → in_issue, into whichever
// issue was open. It is gone, and its absence is the point of the workbench.
// An article that has been measured stays `laid_out` with issue_id NULL —
// that *is* the pool — until someone puts it somewhere. Deciding what goes in
// an issue is the one part of this pipeline that was never the worker's to do.
// See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §2.

// ── Jobs ─────────────────────────────────────────────────────────────────────

/**
 * Compose whatever the website has asked for.
 *
 * One at a time and in the same process as everything else, deliberately: a
 * hundred-page render is most of a gigabyte of Chromium, and this machine has
 * one. Two at once is how the worker gets OOM-killed halfway through both.
 *
 * The loop drains rather than taking one per tick, so a friend who queues three
 * issues does not wait thirty seconds between them.
 */
async function runJobs(): Promise<void> {
  for (;;) {
    const job = await claimJob(db())
    if (!job) return
    log('job_started', { job: job.id, issue: job.issue_id, intent: job.intent })
    const result = await runComposeJob(job, db())
    log(result ? 'job_done' : 'job_failed', { job: job.id, ...(result ?? {}) })
  }
}

// ── The weekly tick ──────────────────────────────────────────────────────────

// closeIfReady and composeAndAsk used to live here — the timer that decided an
// issue was full, rendered it, priced it, and emailed to ask whether to buy it.
// All three are now the Lock and Order buttons in the workbench, because the
// decision they automated is the one most worth making by hand. The compose in
// particular has to run where there is a browser, which a Vercel function is
// not; see plan §9.

/** Follow ordered issues to their conclusion, and archive them (U9). */
async function followOrders(): Promise<void> {
  const settings = loadSettings()
  const lulu = createLuluClient({ settings })

  for (const issue of await issuesInState(['ordered'], db())) {
    if (!issue.lulu_job_id || issue.lulu_job_id === 'pending') continue

    try {
      const job = await lulu.getPrintJob(issue.lulu_job_id)
      if (isRejected(job)) {
        await updateIssue(
          issue.id,
          { state: 'rejected', rejection_reason: job.message, lulu_status: job.status },
          db(),
        )
        log('order_rejected', { issue: issue.number, message: job.message })
        continue
      }
      if (isShipped(job) && !issue.shipped_at) {
        await updateIssue(
          issue.id,
          {
            state: 'shipped',
            shipped_at: new Date().toISOString(),
            lulu_status: job.status,
            tracking_url: job.trackingUrls[0] ?? null,
          },
          db(),
        )
        log('shipped', { issue: issue.number })
      } else if (job.status !== issue.lulu_status) {
        await updateIssue(issue.id, { lulu_status: job.status }, db())
      }
    } catch (err) {
      log('order_poll_failed', { issue: issue.number, reason: (err as Error).message })
    }

    // Archival is idempotent, so re-running it costs nothing and a missed tick
    // is self-healing.
    try {
      const fresh = await getIssue(issue.id, db())
      if (fresh && (fresh.state === 'ordered' || fresh.state === 'shipped')) {
        const result = await archiveIssue(fresh, { db: db() })
        if (!result.alreadyDone) log('archived', { issue: fresh.number, ...result })
      }
    } catch (err) {
      log('archive_failed', { issue: issue.number, reason: (err as Error).message })
    }
  }
}

// ── Schedules ────────────────────────────────────────────────────────────────

export async function runPoll(): Promise<void> {
  // Raindrop is one person's account and one person's token, so what it brings
  // in is one person's reading. Scoped, unlike everything else in this file:
  // a service client here would insert items with no owner and the NOT NULL
  // would refuse them, which is the constraint doing exactly its job.
  const result = await pollRaindrops({ db: pressDb((await ownerAccount()).id) })
  log('polled', { scanned: result.scanned, ingested: result.ingested.length })
  log('extracted', { count: await extractQueued() })
  log('laid_out', { count: await layoutExtracted() })
  // Order status on the poll rather than only the weekly tick: the orders
  // panel has a Refresh button of its own, and this is what keeps it right
  // when nobody is looking at it.
  try {
    const refreshed = await refreshOrders(db())
    if (refreshed.refreshed || refreshed.errors.length) log('orders_refreshed', refreshed)
  } catch (err) {
    log('order_refresh_failed', { reason: (err as Error).message })
  }
  // A machine killed mid-render leaves a `running` row, and the one-live-job
  // index then refuses every new job for that issue — a dead button with no
  // way out but the SQL editor. Reaping on the poll is often enough: the row
  // has to be half an hour stale before it counts.
  try {
    const reaped = await reapStaleJobs(db())
    if (reaped) log('jobs_reaped', { count: reaped })
  } catch (err) {
    log('job_reap_failed', { reason: (err as Error).message })
  }
}

/** Sunday evening PT. The tick is idempotent, so a double fire is harmless. */
export function isWeeklyTick(now: Date): boolean {
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  return pt.getDay() === 0 && pt.getHours() === 19
}

export async function runWeeklyTick(now = new Date()): Promise<void> {
  log('weekly_tick_start')

  // Closing an issue, composing it and asking to buy it used to happen here,
  // on a timer, whenever the open issue crossed the page threshold. It does
  // not any more: you decide when an issue is finished, and the Lock button in
  // the workbench is where that decision is made and where the compose runs.
  //
  // What is left is everything that must happen whether or not anyone is
  // looking: following orders already placed to shipped and archived, and
  // saying once a week what arrived and what broke. The threshold survives in
  // the UI as a progress bar and an Auto-fill button — a guide rail, not a
  // trigger. See plan §8.
  await followOrders()

  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  // Skipped rather than attempted: without a mailer `sendMail` throws, and a
  // thrown weekly tick is a stopped tick — `followOrders` above it would have
  // run, but nothing after it ever would.
  const missingMail = missingSettings('mail')
  if (missingMail.length) {
    log('digest_skipped', { missing: missingMail })
  } else {
    const digest = await sendWeeklyDigest(since, { db: db() })
    log('digest', digest)
  }
  log('weekly_tick_done')
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Fail at boot on a missing secret rather than at 2am on the weekly tick.
  //
  // `db` and `ingest` only. Mail used to be here too, and it was the wrong
  // call: nothing this worker exists to do needs a mailer. Fetching saved
  // links, laying them out, and rendering an issue are the whole job, and a
  // missing RESEND_API_KEY was stopping all three at boot over a weekly digest
  // — a machine that will not start because it cannot send a summary of what
  // it did is a machine that never does anything to summarise.
  for (const unit of ['db', 'ingest'] as const) {
    const missing = missingSettings(unit)
    if (missing.length) throw new Error(`press/worker: ${unit} is missing ${missing.join(', ')}`)
  }

  // Said once, at boot, so an absent digest is a decision you can see in the
  // log rather than a silence you have to go looking for.
  const noMail = missingSettings('mail')
  if (noMail.length) log('no_mailer', { missing: noMail, effect: 'the weekly digest will not send' })

  // No bootstrapIssue(): issues are opened by hand in the workbench now, and
  // there may legitimately be none at all. Arriving articles land in the pool,
  // which needs nothing to exist first.
  log('worker_started', { poll_minutes: POLL_INTERVAL / MINUTE, job_seconds: JOB_INTERVAL / SECOND })

  const guard = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      // A thrown scheduler is a stopped pipeline; log and wait for the next one.
      log('step_failed', { name, reason: (err as Error).message })
      // No owner: a scheduler that threw belongs to nobody's press, and
      // press_events.owner_id is nullable for precisely these (018).
      await recordEvent({ kind: 'worker_error', detail: { step: name, reason: (err as Error).message } }, db())
    }
  }

  await guard('poll', runPoll)
  setInterval(() => void guard('poll', runPoll), POLL_INTERVAL)

  // Serialised against itself: a render outlasts the interval many times over,
  // and a second timer firing into a running drain would claim the next job
  // and start a second Chromium beside the first.
  let jobsRunning = false
  setInterval(() => {
    if (jobsRunning) return
    jobsRunning = true
    void guard('jobs', runJobs).finally(() => {
      jobsRunning = false
    })
  }, JOB_INTERVAL)

  let lastTick = ''
  setInterval(() => {
    const now = new Date()
    const hourKey = now.toISOString().slice(0, 13)
    if (!isWeeklyTick(now) || hourKey === lastTick) return
    lastTick = hourKey
    void guard('weekly', () => runWeeklyTick(now))
  }, TICK_INTERVAL)
}

// Run only when executed directly, so the tests can import the steps.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
