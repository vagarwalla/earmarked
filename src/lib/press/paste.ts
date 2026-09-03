/**
 * press — a block of links, turned into a pool.
 *
 * The whole ingestion story for anybody who is not V. Raindrop and the email
 * door both run on her credentials; a friend gets a textarea, and the first
 * issue of their press should cost them one paste.
 *
 * What this is careful about is saying what happened. A paste that silently
 * absorbs half its input is the same bug as the globally-unique `url_key` that
 * made a friend's copy of an article vanish (018) — so every URL that does not
 * become an article is counted and named, and the panel reports all three
 * numbers rather than "added 31".
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { insertItem, normalizeUrl } from './db'
import type { PressItem } from './types'

/**
 * How many links one paste may carry.
 *
 * Each one is a fetch of an address somebody chose and a render on the one Fly
 * machine, so this is a budget rather than a formatting rule. Fifty is a
 * generous week of reading and about half an issue.
 */
export const MAX_PER_PASTE = 50

/**
 * How many an account may add in a day.
 *
 * The pipeline is one machine shared by everybody, and the cost of a runaway
 * paste is everyone else's issues waiting behind it. Counted from the items
 * themselves rather than a separate table: the rows are already there and
 * already timestamped.
 */
export const MAX_PER_DAY = 200

export interface ParsedPaste {
  /** Deduplicated, in the order they were pasted. */
  urls: string[]
  /** Lines that were not URLs at all. Kept so the panel can say how many. */
  rejected: string[]
  /** Named the same link twice in one paste. */
  duplicates: number
  /** True when the paste was longer than MAX_PER_PASTE and was cut. */
  truncated: boolean
}

/**
 * Pull the links out of whatever was pasted.
 *
 * Split on whitespace rather than on newlines alone, because what arrives is
 * as often a copied paragraph as a tidy list. Markdown and angle-bracket
 * wrapping are stripped for the same reason — a link copied out of a newsletter
 * arrives as `<https://…>` or `](https://…)` more often than bare.
 */
export function parsePaste(raw: string): ParsedPaste {
  const seen = new Set<string>()
  const urls: string[] = []
  const rejected: string[] = []
  let duplicates = 0
  let truncated = false

  for (const token of raw.split(/\s+/)) {
    // A markdown link is one whitespace token — `[title](https://…)` — so the
    // href has to come out of the middle rather than off the ends.
    const md = token.lastIndexOf('](')
    const cleaned = (md === -1 ? token : token.slice(md + 2))
      .replace(/^[<([]+/, '')
      .replace(/[>)\].,;:'"]+$/, '')
    if (!cleaned) continue

    const key = normalizeUrl(cleaned)
    if (!key) {
      rejected.push(cleaned)
      continue
    }
    if (seen.has(key)) {
      duplicates++
      continue
    }
    if (urls.length >= MAX_PER_PASTE) {
      truncated = true
      continue
    }
    seen.add(key)
    urls.push(cleaned)
  }

  return { urls, rejected, duplicates, truncated }
}

export interface PasteResult {
  added: number
  /** Already in this account's pool. Not an error — the dedupe working. */
  alreadyHad: number
  rejected: number
  duplicates: number
  truncated: boolean
  /** Set when the daily cap stopped it, with the sentence to show. */
  refused?: string
}

/** How many articles this account has added since a day ago. */
export async function addedToday(db: SupabaseClient): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await db
    .from('press_items')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
  if (error) throw new Error(`press/paste: addedToday: ${error.message}`)
  return count ?? 0
}

/**
 * Queue what was pasted, and report everything that did not make it.
 *
 * The items land `queued`; the worker's existing extraction picks them up on
 * its next pass, exactly as it does a Raindrop drop. Nothing is fetched here —
 * a paste of fifty links would be a request nobody's browser waits out.
 */
export async function ingestPaste(raw: string, db: SupabaseClient): Promise<PasteResult> {
  const parsed = parsePaste(raw)
  const base: PasteResult = {
    added: 0,
    alreadyHad: 0,
    rejected: parsed.rejected.length,
    duplicates: parsed.duplicates,
    truncated: parsed.truncated,
  }
  if (parsed.urls.length === 0) return base

  const already = await addedToday(db)
  const room = MAX_PER_DAY - already
  if (room <= 0) {
    return {
      ...base,
      refused: `That is ${MAX_PER_DAY} articles in a day, which is the limit. Try again tomorrow.`,
    }
  }

  // Cut to what is left rather than refusing the whole paste: adding forty of
  // fifty and saying so beats adding none.
  const take = parsed.urls.slice(0, room)

  let added = 0
  let alreadyHad = 0
  for (const url of take) {
    // Upserts on (owner_id, url_key) and returns null for a duplicate — so a
    // link this account already has is one article, and re-pasting the same
    // block adds nothing. Somebody else having it is irrelevant, which is the
    // whole point of 018.
    const item = await insertItem({ source: 'paste', url, state: 'queued' }, db)
    if (item) added++
    else alreadyHad++
  }

  return {
    ...base,
    added,
    alreadyHad,
    truncated: parsed.truncated || take.length < parsed.urls.length,
  }
}

/** One sentence for the panel, naming everything that happened. */
export function describePaste(result: PasteResult): string {
  if (result.refused) return result.refused

  const parts = [`${result.added} added`]
  if (result.alreadyHad) parts.push(`${result.alreadyHad} you already had`)
  if (result.duplicates) parts.push(`${result.duplicates} repeated in the paste`)
  if (result.rejected) parts.push(`${result.rejected} that were not links`)

  const sentence = parts.join(', ')
  if (result.added === 0 && result.alreadyHad === 0) {
    return `Nothing to add — ${sentence}.`
  }
  return result.truncated
    ? `${sentence}. The rest was over the limit; paste them next.`
    : `${sentence}. They will appear as they are fetched.`
}

/** Only what a paste can produce; the pipeline treats it like any other item. */
export type PastedItem = PressItem
