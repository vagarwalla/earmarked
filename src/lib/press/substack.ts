/**
 * press — harvesting a reading list out of Substack.
 *
 * The pool a magazine draws from is only as good as its sources. Reading one's
 * own subscriptions produces a narrow, repetitive issue: a handful of prolific
 * writers crowd out everyone else, and the loudest topic wins. This module is
 * the selection logic that turns "every post these publications ever wrote"
 * into a varied shortlist.
 *
 * Substack does the tedious part for us. Three JSON endpoints — archive,
 * recommendations, subscriptions — return `reaction_count`, `restacks`,
 * `comment_count` and `wordcount` per post, so "celebrated" is arithmetic
 * rather than taste. Taste enters in the weights and the caps, which are
 * documented as reasoning rather than magic numbers.
 *
 * Everything here is pure. The fetching, and the Raindrop write, live in
 * `scripts/press-substack.ts`; the method is written up in
 * `docs/press-substack.md`.
 */

// ── Wire shapes ──────────────────────────────────────────────────────────────
// Only the fields the ranking reads; the archive API returns far more.

export interface SubstackPost {
  title: string
  subtitle?: string | null
  canonical_url: string
  /** ISO 8601. */
  post_date: string
  type?: 'newsletter' | 'podcast' | 'restack' | string
  wordcount?: number | null
  reaction_count?: number | null
  restacks?: number | null
  comment_count?: number | null
  publication_id?: number
}

/** A post plus the source it came from and the scores we derived. */
export interface RankedPost {
  title: string
  subtitle: string | null
  url: string
  /** `YYYY-MM-DD`. */
  date: string
  words: number
  engagement: number
  /** Source key — the API host, which is also the per-source cap key. */
  source: string
  publication: string
  topic: string
  tier: 'landmark' | 'key'
}

/** One publication to harvest, keyed by the host that serves its API. */
export interface Source {
  host: string
  publication: string
  topic: string
}

// ── Endpoints ────────────────────────────────────────────────────────────────

/**
 * The reader's own subscriptions. Both query parameters are load-bearing:
 * without `tvOnly` the API answers 400, and without `everything` it returns an
 * empty `publications` array. This one needs the reader's session cookie, so it
 * runs in the browser rather than here.
 */
export const SUBSCRIPTIONS_URL =
  'https://substack.com/api/v1/subscriptions?tvOnly=false&everything=true'

/** One page of a publication's archive. `limit` is capped at 50 server-side. */
export function archiveUrl(host: string, offset = 0, limit = 50): string {
  return `https://${host}/api/v1/archive?sort=new&limit=${limit}&offset=${offset}`
}

/**
 * Publications this one recommends — the reader's network, one hop out. A good
 * way to widen a pool without guessing: these are vouched for by writers the
 * reader already chose.
 */
export function recommendationsUrl(host: string, publicationId: number): string {
  return `https://${host}/api/v1/recommendations/from/${publicationId}`
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * How celebrated a post is, on one scale across every publication.
 *
 * A restack is someone spending their own audience's attention on your piece,
 * which is a far stronger signal than a like, so it carries triple weight. A
 * comment is weak and often adversarial — a fight in the replies is not
 * acclaim — so it counts a half.
 *
 * The earlier version of this scored each post against its own publication's
 * median. That sounds fairer to small newsletters and is not: it let a niche
 * newsletter's merely-above-average post outrank a genuinely iconic essay, and
 * it let the most prolific sources fill the list. Rank absolutely; get variety
 * from the caps instead.
 */
export function engagementScore(post: SubstackPost): number {
  return (
    (post.reaction_count ?? 0) +
    3 * (post.restacks ?? 0) +
    0.5 * (post.comment_count ?? 0)
  )
}

/**
 * "You should read X" posts: link roundups, best-of lists, contest results,
 * housekeeping. They are pointers, not essays, and printing a pointer wastes a
 * page. Note the asymmetry around contests — a contest *entry* is an essay and
 * belongs; the announcement naming its winners does not.
 */
const SIGNPOST = new RegExp(
  [
    String.raw`^\d+\s+(books?|things|lessons|reads?|essays?)\b`,
    String.raw`must[- ]reads?`,
    String.raw`\bwinners?\b|\bfinalists?\b|\bvote\s+in\b|contest\s+rules`,
    String.raw`the\s+winning\s+essays?`,
    String.raw`\blinks?\s+for\b|link\s+round[- ]?up|\bround[- ]?up\b`,
    String.raw`what\s+i(?:'m|\s+am)\s+reading|reading\s+list|\bbookshelf\b`,
    String.raw`\bbest\s+of\s+(the\s+)?(year|20\d\d)\b|\bhighlights\b`,
    String.raw`\bopen\s+thread\b|\bannouncing\b|\bsubscribe\b`,
    String.raw`recommendations?\b`,
  ].join('|'),
  'i',
)

/**
 * A promise of pointers rather than an argument, e.g. "the best things I read
 * in July". It reads as a subtitle but it is just as often the whole title —
 * "Interesting things I read or thought about in June" is a monthly link
 * roundup, and checking only the subtitle let every one of them through.
 */
const POINTERS = /\b(things|pieces|essays|posts)\s+i\s+(read|enjoyed)\b/i

export function isSignpost(title: string, subtitle?: string | null): boolean {
  if (SIGNPOST.test(title ?? '')) return true
  return POINTERS.test(title ?? '') || POINTERS.test(subtitle ?? '')
}

// ── Selection ────────────────────────────────────────────────────────────────

export interface SelectionConfig {
  /** Long-form only. Below this a post is a note, not an essay. */
  minWords: number
  /** Posts on or after this date are `landmark`; older ones are `key`. */
  landmarkFrom: string
  /** The oldest post considered at all. */
  keyFrom: string
  /** Engagement a post must clear to count as celebrated at all. */
  floor: number
  /** Per-source floor overrides, for sources held to a higher bar. */
  floorBySource: Record<string, number>
  /** How many posts any one source may contribute. */
  cap: number
  /** Per-source cap overrides. */
  capBySource: Record<string, number>
  /** Sources dropped wholesale, with the reason kept alongside in the config. */
  excludeSources: Set<string>
  /** Individual URLs to drop, matched as substrings. */
  excludeUrls: Set<string>
}

export const DEFAULT_SELECTION: SelectionConfig = {
  minWords: 2000,
  landmarkFrom: '2025-09-01',
  keyFrom: '2024-09-01',
  floor: 120,
  floorBySource: {},
  cap: 3,
  capBySource: {},
  excludeSources: new Set(),
  excludeUrls: new Set(),
}

/** Why a post did not make it, for the run report. */
export type RejectReason = 'restack' | 'excluded' | 'short' | 'signpost' | 'window' | 'floor' | 'capped'

export interface SelectionResult {
  picks: RankedPost[]
  rejected: Record<RejectReason, number>
}

/**
 * The whole selection, in one pass: filter, score, sort, then walk the sorted
 * list handing out slots until each source hits its cap.
 *
 * Order matters. Capping *after* the global sort is what makes the cap a
 * quality filter rather than a quota — a source's three slots go to its three
 * best posts as measured against everyone else, not against itself.
 */
export function selectPosts(
  posts: Array<SubstackPost & { source: string; publication: string; topic: string }>,
  config: SelectionConfig = DEFAULT_SELECTION,
): SelectionResult {
  const rejected: Record<RejectReason, number> = {
    restack: 0, excluded: 0, short: 0, signpost: 0, window: 0, floor: 0, capped: 0,
  }
  const eligible: RankedPost[] = []

  for (const post of posts) {
    if (post.type === 'restack') { rejected.restack++; continue }
    if (config.excludeSources.has(post.source)) { rejected.excluded++; continue }
    const url = post.canonical_url ?? ''
    if ([...config.excludeUrls].some((fragment) => url.includes(fragment))) {
      rejected.excluded++; continue
    }
    const date = (post.post_date ?? '').slice(0, 10)
    if (date < config.keyFrom) { rejected.window++; continue }
    const words = post.wordcount ?? 0
    if (words < config.minWords) { rejected.short++; continue }
    if (isSignpost(post.title, post.subtitle)) { rejected.signpost++; continue }

    const engagement = engagementScore(post)
    if (engagement < (config.floorBySource[post.source] ?? config.floor)) {
      rejected.floor++; continue
    }
    eligible.push({
      title: post.title,
      subtitle: post.subtitle ?? null,
      url,
      date,
      words,
      engagement: Math.round(engagement),
      source: post.source,
      publication: post.publication,
      topic: post.topic,
      tier: date >= config.landmarkFrom ? 'landmark' : 'key',
    })
  }

  eligible.sort((a, b) => b.engagement - a.engagement)

  const takenBySource = new Map<string, number>()
  const picks: RankedPost[] = []
  for (const post of eligible) {
    const cap = config.capBySource[post.source] ?? config.cap
    const taken = takenBySource.get(post.source) ?? 0
    if (taken >= cap) { rejected.capped++; continue }
    takenBySource.set(post.source, taken + 1)
    picks.push(post)
  }
  return { picks, rejected }
}

/** Tags a pick carries into Raindrop: tier, topic, publication. */
export function tagsFor(post: RankedPost): string[] {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return [post.tier, slug(post.topic), slug(post.publication)].filter(Boolean)
}

/** One scannable line of provenance, shown under the title in Raindrop. */
export function excerptFor(post: RankedPost): string {
  const bits = [post.publication, post.date, `${post.words}w`].join(' · ')
  const text = post.subtitle ? `${post.subtitle.trim()} — ${bits}` : bits
  return text.slice(0, 400)
}
