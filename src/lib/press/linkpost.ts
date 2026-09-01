/**
 * press — linkposts (U3a).
 *
 * Some of what arrives in `hw` is not a piece of writing but a set of pointers
 * at other writing: Zvi's roundups, "assorted links", a LessWrong crosspost
 * that exists only to say "this is a linkpost for X". Printed as-is, those come
 * out as several pages of anchor text with the anchors removed — the words
 * survive, the reading they pointed at does not, and the article reads as a
 * list of titles nobody can follow.
 *
 * So a linkpost is treated as what it is: a piece of front matter for the
 * articles it names. The post itself still prints — the commentary is usually
 * the reason it was saved — and the pieces it points at are fetched, printed
 * after it, and labelled as belonging to it.
 *
 * The judgement of *which* pointers are worth printing is the hard part, and
 * it is a judgement rather than a rule: a roundup links its own archive, the
 * source of a statistic, a bookshop, and four essays, and only the essays are
 * reading. A small deterministic pass decides whether a piece is worth asking
 * about at all; Claude makes the call on the candidates. With no API key the
 * deterministic answer stands on its own, so the pipeline still runs offline.
 *
 * This module holds no IO beyond the one model call.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { Article, ArticleBlock, LinkpostKind, LinkpostTarget } from './types'

/** The judgement is a judgement call, so it gets a real model rather than a cheap one. */
export const LINKPOST_MODEL = 'claude-opus-5'

/**
 * A backstop, not a policy. The model is asked for the pieces that are actually
 * reading, and usually returns a handful; this exists so a pathological roundup
 * cannot turn one save into forty items behind V's back.
 */
export const MAX_TARGETS = 12

/** Below this many outbound links, nothing is a linkpost — it is an essay with citations. */
const MIN_OUTBOUND = 4

/** Anchor text shorter than this is "here", "this", "[1]" — a citation, not a pointer. */
const MIN_ANCHOR_WORDS = 2

// ── Navigation, not content ──────────────────────────────────────────────────
// Shared with scripts/press-links.ts, which harvests the same links for a
// different purpose. One definition, because "what counts as chrome" is a
// judgement that should not drift between two callers.

/**
 * Hosts that are chrome at the apex but not on a subdomain.
 *
 * `substack.com` is navigation — the app, the reader, the subscribe flow. But
 * `<publication>.substack.com` is a publication, and a roundup of Substack
 * writers points almost entirely at those. Matching this by suffix threw away
 * the pointers and kept the furniture, which is backwards for a magazine built
 * out of Substack reading. Plumbing on those subdomains is caught by
 * CHROME_PATHS (/subscribe, /account, /archive), and a link back into the
 * publication you are already reading is caught by the `host === sourceHost`
 * check.
 */
export const CHROME_HOSTS_APEX = ['substack.com']

/** Hosts that are navigation, subscription plumbing, or sharing — never the point. */
export const CHROME_HOSTS = [
  'substackcdn.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'linkedin.com',
  'reddit.com',
  'mail.google.com',
  't.co',
  'patreon.com',
  'paypal.com',
  'amazon.com',
  'bookshop.org',
]

export const CHROME_PATHS = [
  /\/subscribe\b/i,
  /\/unsubscribe\b/i,
  /\/account\b/i,
  /\/comments?\b/i,
  /\/share\b/i,
  /\/refer\b/i,
  /\/archive\b/i,
  /\/about\b/i,
  /\/p\/[^/]+\/comments/i,
]

export const CHROME_TEXT = [
  /^\s*(share|tweet|subscribe|unsubscribe|comment|like|restack|read more|continue reading|view in browser|here|this|link|source|source:|via)\s*$/i,
  /^\s*\[?\d+\]?\s*$/,
  /^\s*$/,
]

/**
 * True when a link is furniture rather than a pointer at something to read.
 * `sourceHost` is the host of the page the link was found on: a link back into
 * the publication you are already reading is navigation.
 */
export function isChrome(url: string, text: string, sourceHost: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const host = parsed.hostname.replace(/^www\./, '')
  if (host === sourceHost) return true
  if (CHROME_HOSTS_APEX.includes(host)) return true
  if (CHROME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true
  if (CHROME_PATHS.some((re) => re.test(parsed.pathname))) return true
  if (CHROME_TEXT.some((re) => re.test(text))) return true
  return false
}

// ── Harvesting ───────────────────────────────────────────────────────────────

export interface OutboundLink {
  /** Absolute http(s) URL, as it appeared in the source. */
  url: string
  /** The words the anchor carried. Without these a harvested link is worthless. */
  text: string
  /** The paragraph, list item or heading it sat in — what the post says about it. */
  context: string
  /** Destination host, `www.` stripped. */
  host: string
  /**
   * The anchor is essentially the whole of the block it sits in: a bare
   * pointer, one link per list item, a heading that is a link. That shape is
   * what separates a roundup from an essay that happens to cite things.
   */
  standalone: boolean
  /** The anchor is inside a heading. Zvi's roundups are built entirely this way. */
  inHeading: boolean
}

/** Blocks whose text is the context for the links inside them. */
const CONTEXT_BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption'

const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

function plain(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Every outbound link in an extracted article, with the words that pointed at
 * it and the sentence around it.
 *
 * Must run on the content root *before* anything flattens it: `toBlocks` calls
 * `inlineHtml`, which deliberately throws the href away because print cannot
 * follow a link. By the time an `Article` exists the hrefs are gone, which is
 * why re-classifying a stored extraction means re-fetching the page.
 */
export function collectOutboundLinks(root: Element, sourceUrl: string): OutboundLink[] {
  const sourceHost = hostOf(sourceUrl)
  const seen = new Set<string>()
  const out: OutboundLink[] = []

  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) continue

    const text = plain(anchor)
    if (isChrome(href, text, sourceHost)) continue

    // One entry per destination: a roundup often links the same piece from a
    // heading and again from the paragraph under it.
    const key = href.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const block = anchor.closest(CONTEXT_BLOCKS)
    const context = plain(block)
    // "Essentially the whole block": allow for a trailing dash and a few words
    // of aside without losing the shape of a bare pointer.
    const standalone = context.length > 0 && text.length / context.length >= 0.6

    out.push({
      url: href,
      text: text.slice(0, 300),
      context: context.slice(0, 600),
      host: hostOf(href),
      standalone,
      inHeading: Boolean(block && HEADINGS.has(block.tagName)),
    })
  }

  return out
}

// ── Deterministic signals ────────────────────────────────────────────────────

export interface LinkpostSignals {
  /** Outbound links left after the chrome filter. */
  outbound: number
  /** How many different places it points at. An essay cites one source repeatedly. */
  distinctHosts: number
  standalone: number
  inHeadings: number
  words: number
  /** Outbound links per 100 words of body. */
  density: number
  /** The post declares itself: "This is a linkpost for <url>". */
  declared: string | null
  /** The title reads like a roundup. */
  titleSuggests: boolean
}

/**
 * LessWrong and the EA Forum print a literal declaration above crossposts.
 * When one is present the question is settled — this is a linkpost for exactly
 * one piece, and no amount of link counting is needed to know it.
 */
const DECLARATION = /this\s+is\s+a\s+link\s?post\s+for\s+(https?:\/\/\S+)/i

/** Titles that announce a roundup. Weak on its own; decisive alongside density. */
const ROUNDUP_TITLE =
  /\b(link ?post|links?(\s+(for|of|round\s?up|post))?|round\s?up|assorted links|what i(?:'ve| have)? been reading|reading list|recommendations|link dump|worth (?:a )?read(?:ing)?|open thread|monthly links|weekly links|this week in)\b/i

function textOfBlocks(blocks: readonly ArticleBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'para' || b.type === 'quote') return b.html.replace(/<[^>]*>/g, ' ')
      if (b.type === 'heading') return b.text
      if (b.type === 'list') return b.items.join(' ').replace(/<[^>]*>/g, ' ')
      return ''
    })
    .join(' ')
}

export function linkpostSignals(
  article: Pick<Article, 'title' | 'blocks'>,
  links: readonly OutboundLink[],
): LinkpostSignals {
  const body = textOfBlocks(article.blocks)
  const words = body.split(/\s+/).filter(Boolean).length
  const declared = DECLARATION.exec(body)?.[1] ?? null

  return {
    outbound: links.length,
    distinctHosts: new Set(links.map((l) => l.host).filter(Boolean)).size,
    standalone: links.filter((l) => l.standalone).length,
    inHeadings: links.filter((l) => l.inHeading).length,
    words,
    density: words > 0 ? (links.length / words) * 100 : 0,
    declared,
    titleSuggests: ROUNDUP_TITLE.test(article.title ?? ''),
  }
}

/**
 * Whether a piece is worth asking the model about.
 *
 * Deliberately generous — a false positive here costs one cheap call and gets
 * refused; a false negative means a roundup prints as a wall of dead anchor
 * text. The one thing it will not do is send an ordinary essay: four outbound
 * links spread through six thousand words is a citation habit, not a linkpost.
 */
export function worthClassifying(signals: LinkpostSignals): boolean {
  if (signals.declared) return true
  if (signals.outbound < MIN_OUTBOUND) return false
  if (signals.distinctHosts < 3) return false
  // A roundup points outward often relative to how much it says.
  if (signals.density >= 0.6) return true
  if (signals.standalone >= 4) return true
  if (signals.inHeadings >= 3) return true
  // Many different destinations is roundup-shaped however much prose surrounds
  // them. Zvi's "On Writing" posts are the case this exists for: thousands of
  // words of commentary threaded through a dozen pointers, so the density and
  // bare-pointer routes both miss, and the title announces nothing. An essay
  // with a citation habit cites a handful of places repeatedly; it does not
  // send you to twelve.
  if (signals.distinctHosts >= 6) return true
  if (signals.titleSuggests && signals.outbound >= MIN_OUTBOUND) return true
  return false
}

/**
 * The answer when there is no API key, or the call failed. Keeps only what the
 * shape of the page already argues for — a standalone pointer with real anchor
 * text — because guessing wide here means printing noise.
 */
export function fallbackTargets(
  links: readonly OutboundLink[],
  limit = MAX_TARGETS,
): LinkpostTarget[] {
  const hosts = new Set<string>()
  const out: LinkpostTarget[] = []
  for (const link of links) {
    if (out.length >= limit) break
    if (!link.standalone && !link.inHeading) continue
    if (link.text.split(/\s+/).filter(Boolean).length < MIN_ANCHOR_WORDS) continue
    // One piece per host: a roundup that points four times at the same blog is
    // pointing at a blog, and we would rather miss the fourth than print it.
    if (hosts.has(link.host)) continue
    hosts.add(link.host)
    out.push({ url: link.url, anchor: link.text, note: null })
  }
  return out
}

// ── The judgement ────────────────────────────────────────────────────────────

export interface LinkpostJudgement {
  isLinkpost: boolean
  kind: LinkpostKind
  /** One line, for the event log and the CLI. */
  reason: string
  targets: LinkpostTarget[]
  /** How the answer was reached, so a surprising issue can be explained later. */
  decidedBy: 'declaration' | 'model' | 'signals'
}

const NOT_A_LINKPOST: Omit<LinkpostJudgement, 'reason' | 'decidedBy'> = {
  isLinkpost: false,
  kind: 'roundup',
  targets: [],
}

const JUDGEMENT_SCHEMA = {
  type: 'object',
  properties: {
    is_linkpost: {
      type: 'boolean',
      description: 'True only if the piece exists mainly to point at other writing.',
    },
    kind: {
      type: 'string',
      enum: ['roundup', 'pointer'],
      description: '"pointer" if it points at one piece; "roundup" if it points at several.',
    },
    reason: { type: 'string', description: 'One sentence, plain, no more than 25 words.' },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The number of the candidate link.' },
          note: {
            type: 'string',
            description: 'What this piece is, in a few words, from what the post says about it.',
          },
        },
        required: ['index', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['is_linkpost', 'kind', 'reason', 'targets'],
  additionalProperties: false,
} as const

interface ModelJudgement {
  is_linkpost: boolean
  kind: LinkpostKind
  reason: string
  targets: Array<{ index: number; note: string }>
}

function candidateList(links: readonly OutboundLink[]): string {
  return links
    .map((link, i) => {
      const shape = [link.standalone ? 'stands alone' : null, link.inHeading ? 'a heading' : null]
        .filter(Boolean)
        .join(', ')
      const lines = [`${i + 1}. "${link.text}" → ${link.host}${shape ? `  (${shape})` : ''}`]
      // The context is what separates "the source of a statistic" from "go read this".
      if (link.context && link.context !== link.text) {
        lines.push(`   in: ${link.context}`)
      }
      return lines.join('\n')
    })
    .join('\n')
}

function outline(blocks: readonly ArticleBlock[], limit = 2000): string {
  const text = textOfBlocks(blocks).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export interface ClassifyOptions {
  article: Pick<Article, 'title' | 'byline' | 'sourceName' | 'url' | 'blocks'>
  links: readonly OutboundLink[]
  apiKey: string | null
  maxTargets?: number
  /** Injectable for tests; defaults to the real SDK call. */
  client?: Pick<Anthropic, 'messages'>
}

/**
 * Decide whether this piece is a linkpost, and if so which of its pointers are
 * reading in their own right.
 *
 * Never throws. A classification failure must leave the article printable — an
 * unrecognised linkpost is a worse issue, not a broken one.
 */
export async function classifyLinkpost(opts: ClassifyOptions): Promise<LinkpostJudgement> {
  const { article, links, apiKey } = opts
  const limit = Math.max(1, Math.min(opts.maxTargets ?? MAX_TARGETS, MAX_TARGETS))
  const signals = linkpostSignals(article, links)

  // A declared crosspost needs no judgement: the page says what it is, and the
  // one URL it names is the whole of it.
  if (signals.declared) {
    return {
      isLinkpost: true,
      kind: 'pointer',
      reason: 'the post declares itself a linkpost',
      targets: [{ url: signals.declared, anchor: article.title ?? signals.declared, note: null }],
      decidedBy: 'declaration',
    }
  }

  if (!worthClassifying(signals)) {
    return { ...NOT_A_LINKPOST, reason: 'reads as a piece of writing, not a set of pointers', decidedBy: 'signals' }
  }

  if (!apiKey || links.length === 0) {
    const targets = fallbackTargets(links, limit)
    if (targets.length < 2) {
      return { ...NOT_A_LINKPOST, reason: 'too few standalone pointers to call it a linkpost', decidedBy: 'signals' }
    }
    return {
      isLinkpost: true,
      kind: 'roundup',
      reason: `${targets.length} standalone pointers across ${signals.distinctHosts} sites`,
      targets,
      decidedBy: 'signals',
    }
  }

  const client = opts.client ?? new Anthropic({ apiKey })

  const prompt = `You are sorting one saved article for a personal print magazine. Someone saves things to read; a pipeline prints them. The question is whether this piece is **a linkpost** — a piece whose substance is pointing the reader at other writing (a links roundup, "assorted links", a weekly digest, a crosspost that exists to point at one essay) — or an ordinary piece of writing that happens to cite things.

TITLE: ${article.title ?? 'Untitled'}
${article.byline ? `BY: ${article.byline}\n` : ''}${article.sourceName ? `PUBLICATION: ${article.sourceName}\n` : ''}
BODY (opening):
${outline(article.blocks)}

CANDIDATE OUTBOUND LINKS (navigation and subscription furniture already removed):
${candidateList(links)}

Two decisions.

First: is this a linkpost? An essay with footnotes and sources is not, however many links it carries. A piece whose paragraphs mostly exist to introduce something else is. When it is genuinely borderline, say no.

Second, if it is: which of the candidate links are pieces of writing the post is actually sending the reader to read — the ones a person would want printed and bound alongside it? Include a link when the post treats it as a thing worth reading in its own right. Leave it out when it is an incidental reference: the source of a number, a definition, a product or a book to buy, a person's homepage, a tweet, a paper cited only in passing, or a pointer back into the author's own archive.

Be selective. Leaving out a borderline pointer costs the reader little; printing a page of somebody's pricing page costs them a page. Return at most ${limit}. If the piece is a linkpost but none of the links are substantive reading, return an empty list.

Refer to links by their number.`

  try {
    const response = await client.messages.create({
      model: LINKPOST_MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: JUDGEMENT_SCHEMA },
      },
      messages: [{ role: 'user', content: prompt }],
    })

    // A refusal is a 200 with no usable content, so it has to be checked rather
    // than caught. Falling through would parse an empty answer as "not a
    // linkpost", which is the one wrong answer that leaves no trace.
    if (response.stop_reason === 'refusal') {
      throw new Error('model declined to answer')
    }

    const parsed = readJudgement(response)
    if (!parsed) throw new Error('no parsable judgement in the response')
    if (!parsed.is_linkpost) {
      return {
        ...NOT_A_LINKPOST,
        reason: parsed.reason?.slice(0, 200) || 'not a linkpost',
        decidedBy: 'model',
      }
    }

    const targets: LinkpostTarget[] = []
    const taken = new Set<number>()
    for (const t of parsed.targets ?? []) {
      const link = links[t.index - 1]
      if (!link || taken.has(t.index)) continue
      taken.add(t.index)
      targets.push({ url: link.url, anchor: link.text, note: t.note?.slice(0, 200) || null })
      if (targets.length >= limit) break
    }

    return {
      isLinkpost: true,
      kind: parsed.kind === 'pointer' ? 'pointer' : 'roundup',
      reason: parsed.reason?.slice(0, 200) || 'a set of pointers at other writing',
      targets,
      decidedBy: 'model',
    }
  } catch (err) {
    console.error(`press/linkpost: falling back to signals: ${(err as Error).message}`)
    const targets = fallbackTargets(links, limit)
    if (targets.length < 2) {
      return { ...NOT_A_LINKPOST, reason: 'classification unavailable; signals were not decisive', decidedBy: 'signals' }
    }
    return {
      isLinkpost: true,
      kind: 'roundup',
      reason: `${targets.length} standalone pointers across ${signals.distinctHosts} sites`,
      targets,
      decidedBy: 'signals',
    }
  }
}

/**
 * The structured answer, whether the SDK parsed it for us or left it as text.
 * `parsed_output` is the happy path; the text fallback covers an SDK version
 * that does not populate it rather than throwing away a good response.
 */
function readJudgement(response: unknown): ModelJudgement | null {
  const message = response as {
    parsed_output?: unknown
    content?: Array<{ type: string; text?: string }>
  }
  if (message.parsed_output && typeof message.parsed_output === 'object') {
    return message.parsed_output as ModelJudgement
  }
  const text = message.content?.find((b) => b.type === 'text')?.text
  if (!text) return null
  try {
    return JSON.parse(text) as ModelJudgement
  } catch {
    return null
  }
}

// ── Running order ────────────────────────────────────────────────────────────

/**
 * Put every linkpost's children directly behind it.
 *
 * An issue is an arrangement of the pool, and dragging articles around is how
 * that arrangement is made — but "the pieces this roundup pointed at" is not an
 * arrangement anyone would want undone by accident. So the invariant is imposed
 * on write rather than defended in the UI: whatever order arrives, each child
 * comes out immediately after its parent, in the order the parent named them.
 *
 * A child whose parent is not in this issue is an ordinary article and keeps
 * its own place. Cycles and self-parenting cannot move anything.
 */
export function orderWithLinkposts(
  itemIds: readonly string[],
  parentOf: (id: string) => string | null | undefined,
): string[] {
  const present = new Set(itemIds)

  const childrenOf = new Map<string, string[]>()
  for (const id of itemIds) {
    const parent = parentOf(id)
    if (!parent || parent === id || !present.has(parent)) continue
    const list = childrenOf.get(parent) ?? []
    list.push(id)
    childrenOf.set(parent, list)
  }

  const emitted = new Set<string>()
  const out: string[] = []

  const emit = (id: string): void => {
    if (emitted.has(id)) return
    emitted.add(id)
    out.push(id)
    for (const child of childrenOf.get(id) ?? []) emit(child)
  }

  for (const id of itemIds) {
    // Children are emitted by their parent. One that is somehow never reached —
    // a cycle — is picked up by the final sweep below rather than dropped.
    const parent = parentOf(id)
    if (parent && parent !== id && present.has(parent)) continue
    emit(id)
  }
  for (const id of itemIds) emit(id)

  return out
}

/**
 * The ids a selection must also take: choosing a linkpost chooses the pieces it
 * points at, because half a roundup is worse than none of it.
 */
export function withLinkpostChildren<T extends { id: string }>(
  chosen: readonly T[],
  all: readonly T[],
  parentOf: (item: T) => string | null | undefined,
): T[] {
  const ids = new Set(chosen.map((i) => i.id))
  const out = [...chosen]
  for (const item of all) {
    if (ids.has(item.id)) continue
    const parent = parentOf(item)
    if (parent && ids.has(parent)) {
      ids.add(item.id)
      out.push(item)
    }
  }
  return out
}
