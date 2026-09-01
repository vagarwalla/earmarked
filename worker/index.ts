/**
 * press — the Fly.io worker (U7).
 *
 * Everything that does not fit in a Vercel function lives here: the Raindrop
 * poll, extraction, layout, and the weekly tick that closes, composes and asks
 * for approval. Chromium and multi-minute renders are the reason this is a
 * separate runtime (assumption 6 in the plan).
 *
 * The machine is stateless — all state is in Supabase — so it can be killed
 * and restarted at any point. Every step below is written to be resumable.
 */

import {
  failItem,
  getIssue,
  getItem,
  insertItem,
  itemsInState,
  issuesInState,
  putObject,
  recordEvent,
  storagePath,
  updateItem,
  updateIssue,
} from '../src/lib/press/db'
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
import type { Article, LinkpostTarget } from '../src/lib/press/types'

const MINUTE = 60_000
const POLL_INTERVAL = 30 * MINUTE
const TICK_INTERVAL = 15 * MINUTE

function log(step: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), step, ...detail }))
}

// ── Pipeline steps ───────────────────────────────────────────────────────────

/** queued → extracted. A failure here is recorded, never silent. */
async function extractQueued(): Promise<number> {
  const items = await itemsInState(['queued'], undefined, 25)
  let done = 0

  const settings = loadSettings()

  for (const item of items) {
    try {
      let article: Article
      let links: OutboundLink[]
      if (item.source === 'newsletter') {
        if (!item.content_path) throw new ExtractionError('newsletter has no stored html', ['newsletter'])
        const html = new TextDecoder().decode(await getObject(item.content_path))
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
      const parent = item.linkpost_parent_id ? await getItem(item.linkpost_parent_id) : null
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
      await putObject(path, JSON.stringify(article), 'application/json')
      await updateItem(item.id, {
        state: 'extracted',
        content_path: path,
        title: article.title,
        byline: article.byline,
        source_name: article.sourceName ?? item.source_name,
        published_at: article.publishedAt ?? item.published_at,
        is_linkpost: Boolean(judgement?.isLinkpost),
        linkpost_scanned_at: new Date().toISOString(),
      })

      if (judgement?.isLinkpost) {
        const added = await queueLinkpostTargets(item.id, judgement.targets)
        log('linkpost', { item: item.id, named: judgement.targets.length, queued: added })
      }
      done++
    } catch (err) {
      await failItem(item.id, (err as Error).message)
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
  parentId: string,
  targets: readonly LinkpostTarget[],
): Promise<number> {
  let added = 0
  for (const target of targets) {
    const inserted = await insertItem({
      source: 'raindrop',
      url: target.url,
      title: target.anchor || null,
      state: 'queued',
      linkpost_parent_id: parentId,
      linkpost_anchor: target.anchor || null,
    })
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
  const items = await itemsInState(['extracted'], undefined, 25)
  let done = 0

  for (const item of items) {
    try {
      if (!item.content_path) throw new Error('extracted item has no article')
      const article = JSON.parse(new TextDecoder().decode(await getObject(item.content_path))) as Article
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
      await putObject(path, result.pdf, 'application/pdf')
      await updateItem(item.id, { state: 'laid_out', fragment_path: path, page_count: result.pageCount })
      done++
    } catch (err) {
      await failItem(item.id, `layout failed: ${(err as Error).message}`)
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

  for (const issue of await issuesInState(['ordered'])) {
    if (!issue.lulu_job_id || issue.lulu_job_id === 'pending') continue

    try {
      const job = await lulu.getPrintJob(issue.lulu_job_id)
      if (isRejected(job)) {
        await updateIssue(issue.id, { state: 'rejected', rejection_reason: job.message, lulu_status: job.status })
        log('order_rejected', { issue: issue.number, message: job.message })
        continue
      }
      if (isShipped(job) && !issue.shipped_at) {
        await updateIssue(issue.id, {
          state: 'shipped',
          shipped_at: new Date().toISOString(),
          lulu_status: job.status,
          tracking_url: job.trackingUrls[0] ?? null,
        })
        log('shipped', { issue: issue.number })
      } else if (job.status !== issue.lulu_status) {
        await updateIssue(issue.id, { lulu_status: job.status })
      }
    } catch (err) {
      log('order_poll_failed', { issue: issue.number, reason: (err as Error).message })
    }

    // Archival is idempotent, so re-running it costs nothing and a missed tick
    // is self-healing.
    try {
      const fresh = await getIssue(issue.id)
      if (fresh && (fresh.state === 'ordered' || fresh.state === 'shipped')) {
        const result = await archiveIssue(fresh)
        if (!result.alreadyDone) log('archived', { issue: fresh.number, ...result })
      }
    } catch (err) {
      log('archive_failed', { issue: issue.number, reason: (err as Error).message })
    }
  }
}

// ── Schedules ────────────────────────────────────────────────────────────────

export async function runPoll(): Promise<void> {
  const result = await pollRaindrops()
  log('polled', { scanned: result.scanned, ingested: result.ingested.length })
  log('extracted', { count: await extractQueued() })
  log('laid_out', { count: await layoutExtracted() })
  // Order status on the poll rather than only the weekly tick: the orders
  // panel has a Refresh button of its own, and this is what keeps it right
  // when nobody is looking at it.
  try {
    const refreshed = await refreshOrders()
    if (refreshed.refreshed || refreshed.errors.length) log('orders_refreshed', refreshed)
  } catch (err) {
    log('order_refresh_failed', { reason: (err as Error).message })
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
  const digest = await sendWeeklyDigest(since)
  log('digest', digest)
  log('weekly_tick_done')
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Fail at boot on a missing secret rather than at 2am on the weekly tick.
  for (const unit of ['db', 'ingest', 'mail'] as const) {
    const missing = missingSettings(unit)
    if (missing.length) throw new Error(`press/worker: ${unit} is missing ${missing.join(', ')}`)
  }

  // No bootstrapIssue(): issues are opened by hand in the workbench now, and
  // there may legitimately be none at all. Arriving articles land in the pool,
  // which needs nothing to exist first.
  log('worker_started', { poll_minutes: POLL_INTERVAL / MINUTE })

  const guard = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      // A thrown scheduler is a stopped pipeline; log and wait for the next one.
      log('step_failed', { name, reason: (err as Error).message })
      await recordEvent({ kind: 'worker_error', detail: { step: name, reason: (err as Error).message } })
    }
  }

  await guard('poll', runPoll)
  setInterval(() => void guard('poll', runPoll), POLL_INTERVAL)

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
