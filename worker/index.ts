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
  bootstrapIssue,
  failItem,
  getIssue,
  getOpenIssue,
  itemsForIssue,
  itemsInState,
  issuesInState,
  putObject,
  recordEvent,
  signedUrl,
  storagePath,
  updateItem,
  updateIssue,
  closeIssue,
} from '../src/lib/press/db'
import { loadSettings, missingSettings } from '../src/lib/press/settings'
import { pollRaindrops } from '../src/lib/press/raindrop'
import { extractFromUrl, extractFromNewsletterHtml, ExtractionError } from '../src/lib/press/extract'
import { renderArticle } from '../src/lib/press/layout/render'
import { composeIssue, shouldCloseIssue } from '../src/lib/press/compose'
import { issueActionTokens, sendApprovalEmail } from '../src/lib/press/approval'
import { createLuluClient, isRejected, isShipped } from '../src/lib/press/lulu'
import { archiveIssue } from '../src/lib/press/archive'
import { sendWeeklyDigest } from '../src/lib/press/digest'
import { getObject } from '../src/lib/press/db'
import type { Article, PressItem } from '../src/lib/press/types'

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

  for (const item of items) {
    try {
      let article: Article
      if (item.source === 'newsletter') {
        if (!item.content_path) throw new ExtractionError('newsletter has no stored html', ['newsletter'])
        const html = new TextDecoder().decode(await getObject(item.content_path))
        article = (
          await extractFromNewsletterHtml({
            itemId: item.id,
            html,
            senderName: item.source_name,
          })
        ).article
      } else {
        if (!item.url) throw new ExtractionError('item has no url', [])
        article = (
          await extractFromUrl({ itemId: item.id, url: item.url, raindropId: item.raindrop_id })
        ).article
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
      })
      done++
    } catch (err) {
      await failItem(item.id, (err as Error).message)
    }
  }

  return done
}

/**
 * extracted → laid_out. The measurement render (KTD7): its page count is what
 * drives the ≥100-page trigger. The fragment is a measurement, not shippable
 * pages — compose re-renders everything.
 */
async function layoutExtracted(): Promise<number> {
  const open = await bootstrapIssue()
  const items = await itemsInState(['extracted'], undefined, 25)
  let done = 0

  for (const item of items) {
    try {
      if (!item.content_path) throw new Error('extracted item has no article')
      const article = JSON.parse(new TextDecoder().decode(await getObject(item.content_path))) as Article
      const result = await renderArticle(article, {
        issueNumber: open.number,
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

/** laid_out → in_issue, joining whichever issue is currently open. */
async function assignToOpenIssue(): Promise<number> {
  const open = await bootstrapIssue()
  const items = await itemsInState(['laid_out'], undefined, 200)
  for (const item of items) {
    await updateItem(item.id, { state: 'in_issue', issue_id: open.id })
  }
  return items.length
}

function pageTotal(items: PressItem[]): number {
  return items.reduce((n, i) => n + (i.page_count ?? 0), 0)
}

// ── The weekly tick ──────────────────────────────────────────────────────────

/** Close the open issue if it is ready, and return it if it closed. */
async function closeIfReady(now: Date) {
  const settings = loadSettings()
  const open = await getOpenIssue()
  if (!open) return null

  const items = await itemsForIssue(open.id)
  const decision = shouldCloseIssue(open, pageTotal(items), settings, now)
  log('close_check', { issue: open.number, ...decision })
  if (!decision.close) return null

  return closeIssue(open.id, decision.pageTotal)
}

/**
 * Compose a closed issue and ask for approval. Re-sent on every tick while the
 * issue is still waiting, so a buried email cannot stall the loop.
 */
async function composeAndAsk(issueId: string, now: Date): Promise<void> {
  const settings = loadSettings()
  const issue = await getIssue(issueId)
  if (!issue) return

  const composed = await composeIssue(issue)
  log('composed', {
    issue: composed.number,
    name: composed.name,
    pages: composed.pageCount,
    skipped: composed.skipped.length,
    preflight: composed.preflight,
  })

  let quote = null
  try {
    if (settings.shipping) {
      quote = await createLuluClient({ settings }).quote(
        {
          title: composed.name,
          packageId: settings.luluPackageId,
          pageCount: composed.pageCount,
          quantity: 1,
        },
        settings.shipping,
      )
      await updateIssue(issue.id, { quote_cents: quote.totalCents, quote_currency: quote.currency })
    }
  } catch (err) {
    // A quote is information, not a gate. Say so in the email rather than
    // holding the issue back over it.
    log('quote_failed', { issue: composed.number, reason: (err as Error).message })
  }

  const tokens = await issueActionTokens(
    issue.id,
    [
      { action: 'approve' },
      { action: 'skip' },
      ...composed.toc.map((e) => ({ action: 'drop' as const, itemId: e.itemId })),
    ],
    { now },
  )

  const approve = tokens.find((t) => t.action === 'approve')!
  const skip = tokens.find((t) => t.action === 'skip')!
  const dropUrls = new Map(
    tokens.filter((t) => t.action === 'drop' && t.itemId).map((t) => [t.itemId as string, t.url]),
  )

  await sendApprovalEmail(issue.id, {
    issueNumber: composed.number,
    issueName: composed.name,
    pageCount: composed.pageCount,
    quote,
    toc: composed.toc,
    previewUrl: await signedUrl(storagePath.interior(issue.id), 30 * 24 * 60 * 60),
    approveUrl: approve.url,
    skipUrl: skip.url,
    dropUrls,
  })
  log('approval_sent', { issue: composed.number })
}

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
  log('assigned', { count: await assignToOpenIssue() })
}

/** Sunday evening PT. The tick is idempotent, so a double fire is harmless. */
export function isWeeklyTick(now: Date): boolean {
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  return pt.getDay() === 0 && pt.getHours() === 19
}

export async function runWeeklyTick(now = new Date()): Promise<void> {
  log('weekly_tick_start')

  const closed = await closeIfReady(now)
  if (closed) await composeAndAsk(closed.id, now)

  // Anything still waiting on V — including a rejection that has been fixed —
  // gets composed and asked about again.
  for (const issue of await issuesInState(['closed', 'rejected'])) {
    if (closed && issue.id === closed.id) continue
    try {
      await composeAndAsk(issue.id, now)
    } catch (err) {
      log('compose_failed', { issue: issue.number, reason: (err as Error).message })
    }
  }

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

  await bootstrapIssue()
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
