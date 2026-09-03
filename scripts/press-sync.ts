/**
 * press — one command that keeps everything in step.
 *
 * Press lives in two places and neither is wrong. The website at
 * earmarked.vaidehiagarwalla.com is where an issue gets reordered; this
 * machine is the only place that can render one, because that is minutes of
 * headless Chromium and no serverless function will do it.
 *
 * Left alone, those two drift: a reorder made in the browser never reaches the
 * renderer, and a rebuild here never reaches the website. This closes the loop.
 *
 *   npm run press:sync              # the whole round trip
 *   npm run press:sync -- --dry-run # say what it would do
 *   npm run press:sync -- --no-poll # skip Raindrop; just reconcile and build
 *
 * The round trip, in order:
 *
 *   1. PULL   the running order from Supabase into `.press/state.json`. The
 *             website is authoritative for *order*, because that is the only
 *             place anyone changes it by hand.
 *   2. POLL   Raindrop for new saves and extract them (scripts/press-run.ts).
 *             Authoritative for *contents*, because that is where reading
 *             arrives.
 *   3. BUILD  if the draft no longer matches the PDFs on disk.
 *   4. PUSH   items, issues, PDFs and the built order back to Supabase.
 *
 * Safe to run on a timer: every step is idempotent, and step 3 does nothing
 * when nothing changed, so a quiet run costs one Raindrop call and a few
 * queries.
 */

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { buildIssue, withBuildLock, BuildError, BuildBusyError } from '../src/lib/press/build'
import { withStateLock, type PressState } from '../src/lib/press/issues'
import { loadSettings } from '../src/lib/press/settings'

const ROOT = path.join(process.cwd(), '.press')
const DRY = process.argv.includes('--dry-run')
const NO_POLL = process.argv.includes('--no-poll')

const say = (line: string) => console.log(`${DRY ? '[dry] ' : ''}${line}`)

function client(): SupabaseClient {
  const { supabaseUrl, supabaseServiceKey } = loadSettings()
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local')
  }
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// ── 1. Pull the running order the website is showing ─────────────────────────

/**
 * Supabase rows carry `raindrop_id`, which *is* the local item id — that is
 * how `press-import` matches them — so the order comes back across without
 * needing a second identity map.
 */
async function pull(db: SupabaseClient): Promise<boolean> {
  const { data: issues, error } = await db
    .from('press_issues')
    .select('id,number,state')
    .order('number', { ascending: true })
  if (error) throw new Error(`pull: ${error.message}`)

  let changed = false
  for (const issue of (issues ?? []) as { id: string; number: number; state: string }[]) {
    const { data: items } = await db
      .from('press_items')
      .select('raindrop_id,position')
      .eq('issue_id', issue.id)
      .order('position', { ascending: true, nullsFirst: false })

    const remoteOrder = ((items ?? []) as { raindrop_id: string | null }[])
      .map((i) => i.raindrop_id)
      .filter((id): id is string => Boolean(id))
    if (remoteOrder.length === 0) continue

    const applied = await withStateLock((state: PressState) => {
      state.issues ??= []
      const draft = state.issues.find((d) => d.number === issue.number)
      if (!draft) {
        state.issues.push({ number: issue.number, itemIds: remoteOrder, state: 'draft' })
        return true
      }
      if (sameOrder(draft.itemIds, remoteOrder)) return false
      if (DRY) return false
      draft.itemIds = remoteOrder
      return true
    })

    if (applied) {
      say(`pulled issue ${issue.number}: order changed on the website`)
      changed = true
    }
  }
  if (!changed) say('pulled: the website and this machine already agree')
  return changed
}

// ── 2. Poll and extract ──────────────────────────────────────────────────────

function poll(): void {
  if (NO_POLL) return say('skipping the Raindrop poll (--no-poll)')
  if (DRY) return say('would poll Raindrop and extract anything new')

  // press-run owns the Raindrop and extraction path; running it as-is keeps one
  // implementation of that rather than a second copy here.
  const result = spawnSync(
    process.execPath,
    ['--env-file=.env.local', './node_modules/.bin/tsx', 'scripts/press-run.ts'],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error('press-run failed; not building on top of that')
}

// ── 3. Rebuild only when the PDFs no longer match the draft ──────────────────

async function rebuildIfStale(): Promise<boolean> {
  const state = JSON.parse(await readFile(path.join(ROOT, 'state.json'), 'utf8')) as PressState
  const settings = loadSettings()
  let built = false

  for (const draft of state.issues ?? []) {
    if (draft.state === 'ordered') continue

    const dir = path.join(ROOT, `issue-${draft.number}`)
    let builtOrder: string[] = []
    try {
      const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as {
        articles: { id: string }[]
      }
      builtOrder = meta.articles.map((a) => a.id)
    } catch {
      // Never built.
    }

    if (existsSync(path.join(dir, 'interior.pdf')) && sameOrder(draft.itemIds, builtOrder)) {
      say(`issue ${draft.number}: PDFs are current`)
      continue
    }
    if (draft.itemIds.length === 0) continue
    if (DRY) {
      say(`would rebuild issue ${draft.number} (${draft.itemIds.length} articles)`)
      built = true
      continue
    }

    const byId = new Map(state.items.map((i) => [i.id, i]))
    const items = draft.itemIds
      .map((id) => byId.get(id))
      .filter((i): i is NonNullable<typeof i> => Boolean(i))
      .map((i) => ({ id: i.id, title: i.title, url: i.url, pageCount: i.pageCount }))

    say(`rebuilding issue ${draft.number} (${items.length} articles) — this takes a few minutes`)
    try {
      const result = await withBuildLock(() =>
        buildIssue({
          number: draft.number,
          items,
          name: draft.name,
          apiKey: settings.anthropicApiKey,
          onProgress: (m) => console.log(`   ${m}…`),
        }),
      )
      console.log(`   built "${result.name}" — ${result.pageCount} pages`)
      built = true
    } catch (err) {
      // A busy lock means press-run is mid-compose in another terminal; that is
      // not a failure worth aborting the sync for.
      if (err instanceof BuildBusyError) say(`issue ${draft.number}: a build is already running`)
      else if (err instanceof BuildError) say(`issue ${draft.number}: ${err.message}`)
      else throw err
    }
  }
  return built
}

// ── 4. Push everything back ──────────────────────────────────────────────────

function push(): void {
  if (DRY) return say('would import items, issues and PDFs into Supabase')
  const result = spawnSync(
    process.execPath,
    ['--env-file=.env.local', './node_modules/.bin/tsx', 'scripts/press-import.ts'],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error('press-import failed')
}

async function main(): Promise<void> {
  if (!existsSync(ROOT)) throw new Error('no .press/ — run scripts/press-run.ts first')
  const db = client()

  say('1/4 pulling the running order from the website…')
  await pull(db)

  say('2/4 polling for new reading…')
  poll()

  say('3/4 rebuilding if anything moved…')
  await rebuildIfStale()

  say('4/4 pushing back to the website…')
  push()

  say('in sync.')
}

main().catch((err) => {
  console.error(`press-sync: ${(err as Error).message}`)
  process.exit(1)
})
