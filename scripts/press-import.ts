/**
 * press — lift the local pipeline's state into Supabase.
 *
 * `scripts/press-run.ts` built everything on this machine: `.press/state.json`,
 * one directory of extracted articles and images per item, and a composed
 * issue with its two PDFs. The deployed review page reads Postgres and Storage
 * instead, so this is the one-time bridge between them.
 *
 *   npm run press:import -- --dry-run   # say what would happen, touch nothing
 *   npm run press:import
 *
 * Idempotent: items are matched on `raindrop_id` and issues on `number`, so a
 * second run updates rather than duplicates. Safe to re-run after adding more
 * reading locally.
 *
 * What maps to what:
 *   local item id            -> press_items.raindrop_id (the id *is* the drop id)
 *   .press/items/<id>/…      -> Storage `press` bucket, same layout as storagePath
 *   state.issues[].itemIds   -> press_items.issue_id + .position, in order
 *   .press/issue-N/*.pdf     -> Storage, and press_issues.interior_path/cover_path
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadSettings } from '../src/lib/press/settings'
import { normalizeUrl, storagePath } from '../src/lib/press/db'
import type { ItemState } from '../src/lib/press/types'

const ROOT = path.join(process.cwd(), '.press')
const DRY = process.argv.includes('--dry-run')

interface LocalItem {
  id: string
  url: string
  raindropId: string
  title: string | null
  state: 'queued' | 'laid_out' | 'printed' | 'failed' | 'skipped'
  pageCount?: number
  reason?: string
  savedAt: string
}

interface LocalState {
  issueNumber: number
  items: LocalItem[]
  issues?: { number: number; itemIds: string[]; state: 'draft' | 'ordered' }[]
  printed: { number: number; name: string; orderedAt: string; itemIds: string[] }[]
}

interface IssueMeta {
  number: number
  name: string
  pageCount: number
  builtAt: string
  articles: { id: string; title: string | null; url: string; pageCount?: number }[]
}

const say = (line: string) => console.log(`${DRY ? '[dry] ' : ''}${line}`)

function client(): SupabaseClient {
  const { supabaseUrl, supabaseServiceKey } = loadSettings()
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Local states line up one-for-one now that 011 admits `skipped`. */
function itemState(local: LocalItem, inIssue: boolean): ItemState {
  if (local.state === 'laid_out') return inIssue ? 'in_issue' : 'laid_out'
  if (local.state === 'printed') return 'printed'
  if (local.state === 'failed') return 'failed'
  if (local.state === 'skipped') return 'skipped'
  return 'queued'
}

async function upload(
  db: SupabaseClient,
  bucket: string,
  storeAt: string,
  localFile: string,
  contentType: string,
): Promise<void> {
  if (!existsSync(localFile)) return
  if (DRY) return say(`  upload ${storeAt}`)
  const body = await readFile(localFile)
  const { error } = await db.storage
    .from(bucket)
    .upload(storeAt, body, { contentType, upsert: true })
  if (error) throw new Error(`upload ${storeAt}: ${error.message}`)
}

/** Everything under .press/items/<id>/ — the article JSON and its images. */
async function uploadItemFiles(db: SupabaseClient, bucket: string, itemId: string): Promise<void> {
  const dir = path.join(ROOT, 'items', itemId)
  if (!existsSync(dir)) return

  await upload(db, bucket, storagePath.articleJson(itemId), path.join(dir, 'article.json'), 'application/json')

  const imageDir = path.join(dir, 'images')
  if (!existsSync(imageDir)) return
  for (const name of await readdir(imageDir)) {
    const ext = path.extname(name).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    await upload(db, bucket, storagePath.image(itemId, name), path.join(imageDir, name), type)
  }
}

async function main(): Promise<void> {
  const settings = loadSettings()
  const bucket = settings.storageBucket
  const db = client()

  const state = JSON.parse(await readFile(path.join(ROOT, 'state.json'), 'utf8')) as LocalState
  say(`importing ${state.items.length} items from ${ROOT}`)

  // Which local ids belong to which issue number, and in what order.
  const membership = new Map<string, { number: number; position: number }>()
  for (const draft of state.issues ?? []) {
    draft.itemIds.forEach((id, position) => membership.set(id, { number: draft.number, position }))
  }
  for (const past of state.printed) {
    past.itemIds.forEach((id, position) => membership.set(id, { number: past.number, position }))
  }

  // ── Issues first: items reference them. ────────────────────────────────────
  const issueIdByNumber = new Map<number, string>()
  const dirs = existsSync(ROOT)
    ? (await readdir(ROOT, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^issue-\d+$/.test(d.name))
        .map((d) => Number.parseInt(d.name.replace('issue-', ''), 10))
    : []
  const numbers = new Set<number>([...dirs, ...(state.issues ?? []).map((i) => i.number), state.issueNumber])

  for (const number of [...numbers].sort((a, b) => a - b)) {
    const dir = path.join(ROOT, `issue-${number}`)
    let meta: IssueMeta | null = null
    try {
      meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as IssueMeta
    } catch {
      // Never composed; it still needs a row so its draft has somewhere to hang.
    }
    const printed = state.printed.find((p) => p.number === number)
    const draft = state.issues?.find((i) => i.number === number)

    const row = {
      number,
      // Only `ordered` locally means a copy was actually bought.
      state: printed || draft?.state === 'ordered' ? ('ordered' as const) : ('open' as const),
      name: meta?.name ?? printed?.name ?? null,
      page_total: meta?.pageCount ?? 0,
      interior_path: existsSync(path.join(dir, 'interior.pdf')) ? null : null,
      cover_path: existsSync(path.join(dir, 'cover.pdf')) ? null : null,
      updated_at: new Date().toISOString(),
    }

    if (DRY) {
      say(`issue ${number}: "${row.name ?? '(unnamed)'}" ${row.page_total}pp, state ${row.state}`)
      issueIdByNumber.set(number, `dry-${number}`)
      continue
    }

    const { data: existing } = await db.from('press_issues').select('id').eq('number', number).maybeSingle()
    let issueId: string
    if (existing) {
      issueId = (existing as { id: string }).id
      const { error } = await db.from('press_issues').update(row).eq('id', issueId)
      if (error) throw new Error(`issue ${number}: ${error.message}`)
    } else {
      const { data, error } = await db.from('press_issues').insert(row).select('id').single()
      if (error) throw new Error(`issue ${number}: ${error.message}`)
      issueId = (data as { id: string }).id
    }
    issueIdByNumber.set(number, issueId)

    // Storage paths key off the issue's UUID, so they can only be written once
    // the row exists.
    const paths: Record<string, string | null> = {}
    if (existsSync(path.join(dir, 'interior.pdf'))) {
      await upload(db, bucket, storagePath.interior(issueId), path.join(dir, 'interior.pdf'), 'application/pdf')
      paths.interior_path = storagePath.interior(issueId)
    }
    if (existsSync(path.join(dir, 'cover.pdf'))) {
      await upload(db, bucket, storagePath.cover(issueId), path.join(dir, 'cover.pdf'), 'application/pdf')
      paths.cover_path = storagePath.cover(issueId)
    }
    if (Object.keys(paths).length) await db.from('press_issues').update(paths).eq('id', issueId)

    // What the PDFs were actually rendered from (012). Without this the site
    // cannot tell a current issue from a stale one, and would keep offering to
    // rebuild something that is already correct. meta.json holds local ids;
    // press_items rows are matched on raindrop_id, which is the same id.
    if (meta?.articles?.length) {
      const { data: rows } = await db
        .from('press_items')
        .select('id,raindrop_id')
        .eq('issue_id', issueId)
      const idByLocal = new Map(
        ((rows ?? []) as { id: string; raindrop_id: string | null }[]).map((r) => [r.raindrop_id, r.id]),
      )
      const builtOrder = meta.articles
        .map((a) => idByLocal.get(a.id))
        .filter((id): id is string => Boolean(id))
      if (builtOrder.length === meta.articles.length) {
        await db.from('press_issues').update({ built_order: builtOrder }).eq('id', issueId)
      }
    }

    say(`issue ${number}: "${row.name ?? '(unnamed)'}" ${row.page_total}pp -> ${issueId}`)
  }

  // ── Items. ─────────────────────────────────────────────────────────────────
  let imported = 0
  for (const item of state.items) {
    const where = membership.get(item.id)
    const issueId = where ? (issueIdByNumber.get(where.number) ?? null) : null
    const row = {
      url: item.url,
      // The same normalisation the ingest path uses, so a link re-dropped
      // later dedupes against what is imported here rather than doubling.
      url_key: normalizeUrl(item.url),
      source: 'raindrop' as const,
      raindrop_id: item.raindropId,
      state: itemState(item, Boolean(issueId)),
      issue_id: issueId,
      position: where?.position ?? null,
      title: item.title,
      page_count: item.pageCount ?? null,
      failure_reason: item.reason ?? null,
      content_path: existsSync(path.join(ROOT, 'items', item.id, 'article.json'))
        ? storagePath.articleJson(item.id)
        : null,
      created_at: item.savedAt,
      updated_at: new Date().toISOString(),
    }

    if (DRY) {
      say(`item ${item.raindropId} ${row.state}${where ? ` @${where.position}` : ''} — ${item.title ?? item.url}`)
      imported++
      continue
    }

    const { data: existing } = await db
      .from('press_items')
      .select('id')
      .eq('raindrop_id', item.raindropId)
      .maybeSingle()

    if (existing) {
      const { error } = await db.from('press_items').update(row).eq('id', (existing as { id: string }).id)
      if (error) throw new Error(`item ${item.raindropId}: ${error.message}`)
    } else {
      const { error } = await db.from('press_items').insert(row)
      if (error) throw new Error(`item ${item.raindropId}: ${error.message}`)
    }

    await uploadItemFiles(db, bucket, item.id)
    imported++
  }

  say(`done: ${imported} items, ${issueIdByNumber.size} issues`)
  if (DRY) say('nothing was written — drop --dry-run to import for real')
}

main().catch((err) => {
  console.error(`press-import: ${(err as Error).message}`)
  process.exit(1)
})
