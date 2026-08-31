/**
 * press — issue naming (KTD8).
 *
 * Printed issues become Raindrop collections named after themselves, so the
 * name is the archive key, not just cover text. A small fast model reads the
 * table of contents and returns a short title; when the API key is absent or
 * the call fails we fall back to a deterministic date-range name, because an
 * issue that cannot be named is an issue that cannot be archived.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { TocEntry } from './types'

/** The plan asks for a small, fast model — naming an issue costs fractions of a cent. */
export const NAMING_MODEL = 'claude-haiku-4-5'

const MAX_NAME_LENGTH = 48

/**
 * Trim a model's answer down to something that can sit on a cover and in a
 * Raindrop collection name: one line, no quotes, no trailing punctuation, no
 * characters that would make a mess of a folder name.
 */
export function sanitizeIssueName(raw: string): string {
  const oneLine = raw.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  return oneLine
    // Models like to wrap titles in quotes, and to preface them.
    .replace(/^(?:title|issue name)\s*:\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    // Raindrop collection names live in a path-ish namespace; em dash is ours.
    .replace(/[\\/—|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim()
}

/** `YYYY-MM-DD` in UTC — the date half of an archive collection name. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** The deterministic name used when the model is unavailable. */
export function fallbackIssueName(issueNumber: number): string {
  return `Issue ${issueNumber}`
}

/**
 * The Raindrop collection an ordered issue is archived into (U9).
 * Dated by the order date so the shelf reads chronologically.
 */
export function archiveCollectionName(orderDate: Date, issueName: string): string {
  return `${isoDate(orderDate)} — ${issueName}`
}

function tocDigest(toc: TocEntry[]): string {
  return toc
    .map((e) => {
      const parts = [e.title]
      if (e.byline) parts.push(`by ${e.byline}`)
      if (e.sourceName) parts.push(`(${e.sourceName})`)
      return `- ${parts.join(' ')}`
    })
    .join('\n')
}

export interface NameIssueOptions {
  issueNumber: number
  toc: TocEntry[]
  apiKey: string | null
  /** Injectable for tests; defaults to the real SDK call. */
  client?: Pick<Anthropic, 'messages'>
}

/**
 * Name an issue from its contents. Never throws: a naming failure must not
 * block a composed issue from reaching the approval email.
 */
export async function nameIssue(opts: NameIssueOptions): Promise<string> {
  const { issueNumber, toc, apiKey } = opts
  if (!apiKey || toc.length === 0) return fallbackIssueName(issueNumber)

  const client = opts.client ?? new Anthropic({ apiKey })

  const prompt = `Below is the table of contents for one issue of a personal print magazine — a reader's own saved reading, collected and printed.

${tocDigest(toc)}

Give the issue a short title: two to four words, no subtitle, no colon, no quotes. It should hint at what these pieces have in common — a theme, a mood, a shared preoccupation. If they have nothing in common, name it for the most striking piece. Neutral and plain is better than clever.

Reply with the title alone and nothing else.`

  try {
    const response = await client.messages.create({
      model: NAMING_MODEL,
      max_tokens: 64,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = response.content.find((b) => b.type === 'text')?.text ?? ''
    const name = sanitizeIssueName(text)
    return name || fallbackIssueName(issueNumber)
  } catch (err) {
    console.error(`press/naming: falling back to a date-range name: ${(err as Error).message}`)
    return fallbackIssueName(issueNumber)
  }
}
