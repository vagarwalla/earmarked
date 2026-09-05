/**
 * press — how a cover gets chosen.
 *
 * The covers used to be assigned by arithmetic: composition `(n - 1) % 9`,
 * palette rotated by `n`, every composition drawn in all six colours. That
 * produced a shelf where the picture had nothing to do with the reading and
 * every cover was the same rainbow in a different arrangement — six hues is
 * not a palette, it is the absence of a choice.
 *
 * So this is the brief an art director would be given, written down. Two
 * decisions, both made from the table of contents:
 *
 *   a SCHEME — two or three colours out of the six, and the ground under them
 *   a FIGURE — which composition, chosen for what the issue is *about*
 *
 * The rules below are the instructions. They are deliberately explicit rather
 * than left to taste, because they are applied by a small model reading a list
 * of article titles, and because a rule that is written down can be argued
 * with — see `coverBriefPrompt`, which is these same rules, addressed.
 *
 * Restraint is the whole point. Two colours and a ground will always look more
 * expensive than six, and an issue about Soviet planning should not arrive in
 * marigold and viridian because it happens to be issue five.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { TocEntry } from './types'

// ── The colours ──────────────────────────────────────────────────────────────

/**
 * The six inks, unchanged: warm-dominant with two cool anchors, in the
 * register of a riso-printed art magazine. What changes is that a cover now
 * uses two or three of them rather than all six.
 */
export const INKS = {
  marigold: '#E9A93A',
  persimmon: '#D9603B',
  crimson: '#B8324B',
  plum: '#6E3A6B',
  ultramarine: '#2B4C9B',
  viridian: '#1E7F6B',
} as const

export type InkName = keyof typeof INKS

/**
 * The grounds, deepened.
 *
 * These were four percent of colour and read as "cream" on every issue — the
 * difference existed in the file and not on the shelf, which is the same as
 * not existing. They now carry enough tint to be told apart at arm's length
 * while staying paper rather than becoming a colour field, and the ink they
 * are named for is the one they sit under.
 */
export const GROUNDS: Record<InkName | 'plain', string> = {
  plain: '#F4F1EA', // the original cream
  marigold: '#F6EBD3', // warm sand
  persimmon: '#F5E3D6', // pale clay
  crimson: '#F3DEDE', // dusty rose
  plum: '#EBE2EE', // pale lilac
  ultramarine: '#DFE7F2', // soft blue-grey
  viridian: '#DCEAE0', // pale sage
}

/**
 * A cover's colours: one or two inks that carry the figure, and the ground.
 *
 * Named for what they are *for* rather than for their hues, because the model
 * choosing between them is reading article titles, not swatches. Every scheme
 * is at most three colours including the ground.
 */
export interface Scheme {
  name: string
  /** What this scheme is for, in the words the chooser sees. */
  suits: string
  inks: InkName[]
  ground: InkName | 'plain'
}

export const SCHEMES: Scheme[] = [
  {
    name: 'ember',
    suits: 'heat, urgency, damage, things going wrong — disease, war, crisis, collapse',
    inks: ['persimmon', 'crimson'],
    ground: 'persimmon',
  },
  {
    name: 'archive',
    suits: 'history, institutions, bureaucracy, the state, the twentieth century',
    inks: ['crimson', 'plum'],
    ground: 'crimson',
  },
  {
    name: 'cold',
    suits: 'systems, planning, machinery, computation, measurement, economics',
    inks: ['ultramarine', 'plum'],
    ground: 'ultramarine',
  },
  {
    name: 'field',
    suits: 'nature, medicine, biology, growth, agriculture, the living world',
    inks: ['viridian', 'marigold'],
    ground: 'viridian',
  },
  {
    name: 'daylight',
    suits: 'optimism, invention, progress, building things, wealth, energy',
    inks: ['marigold', 'persimmon'],
    ground: 'marigold',
  },
  {
    name: 'study',
    suits: 'writing, art, interiority, essays, criticism, quiet reflection',
    inks: ['plum', 'marigold'],
    ground: 'plum',
  },
  {
    name: 'depth',
    suits: 'science, distance, the very large or very small, space, the sea, abstraction',
    inks: ['ultramarine', 'viridian'],
    ground: 'ultramarine',
  },
]

// ── The figures ──────────────────────────────────────────────────────────────

/**
 * What each composition is *for*.
 *
 * The drawings themselves are unchanged and still live in `compose.ts`; this
 * is the half that was missing — a reason to pick one. `suits` is written for
 * the chooser, and is the only description it sees.
 */
export interface Figure {
  name: string
  suits: string
}

export const FIGURES: Figure[] = [
  { name: 'orbit', suits: 'scale, distance, one thing radiating outward from a source; influence, spread, consequence' },
  { name: 'horizon', suits: 'place, landscape, travel, the natural world, a subject you look across rather than into' },
  { name: 'column', suits: 'comparison, categories, many separate cases side by side, counting and measurement' },
  { name: 'fan', suits: 'possibility, divergence, forecasts, futures branching from one point' },
  { name: 'stack', suits: 'layers, strata, history in sequence, a subject built up over time' },
  { name: 'lens', suits: 'focus, examination, a single subject looked at closely; investigation, evidence' },
  { name: 'chevron', suits: 'movement, direction, conflict, force, a subject with a strong current through it' },
  { name: 'nested', suits: 'structure, containment, institutions, systems inside systems, order' },
  { name: 'arch', suits: 'building, civilisation, human making, monuments, culture and its architecture' },
]

// ── Choosing ─────────────────────────────────────────────────────────────────

export interface CoverBrief {
  scheme: Scheme
  figure: Figure
}

/**
 * The brief, addressed to whoever is choosing. This is the prompt, and it is
 * kept beside the rules it states so the two cannot drift apart.
 */
export function coverBriefPrompt(issueName: string, toc: TocEntry[]): string {
  const contents = toc.map((e) => `- ${e.title}`).join('\n')
  return [
    'You are art-directing the cover of a printed magazine of saved reading.',
    '',
    `The issue is called "${issueName}". Its contents:`,
    contents,
    '',
    'Pick one colour scheme and one composition, by what the issue is ABOUT.',
    '',
    'Colour schemes:',
    ...SCHEMES.map((s) => `- ${s.name}: ${s.suits}`),
    '',
    'Compositions:',
    ...FIGURES.map((f) => `- ${f.name}: ${f.suits}`),
    '',
    'Judge the issue as a whole, by the subject most of the articles share.',
    'Ignore any single outlier. If two schemes fit, take the quieter one.',
    '',
    'Answer with exactly two words, lowercase, separated by one space:',
    'the scheme name then the composition name. Nothing else.',
  ].join('\n')
}

/** Read the model's two words back, or null if it did not follow the brief. */
export function parseCoverBrief(raw: string): CoverBrief | null {
  const words: string[] = raw.toLowerCase().match(/[a-z]+/g) ?? []
  const scheme = SCHEMES.find((s) => words.includes(s.name))
  const figure = FIGURES.find((f) => words.includes(f.name))
  return scheme && figure ? { scheme, figure } : null
}

/**
 * The cover an issue gets when nobody is available to choose one.
 *
 * Not a default — a rotation, so a press with no API key still gets a varied
 * shelf rather than seven identical covers. Two different moduli so the pair
 * does not repeat until both cycle.
 */
export function fallbackBrief(issueNumber: number): CoverBrief {
  const n = Math.trunc(issueNumber)
  const at = (len: number, step: number) => ((n - 1) * step % len + len) % len
  return { scheme: SCHEMES[at(SCHEMES.length, 1)], figure: FIGURES[at(FIGURES.length, 2)] }
}

/**
 * Mix two hex colours. `t` is how much of `b` to take.
 *
 * Done here rather than with `color-mix()` in the stylesheet for the reason
 * the cover template gives: the render browser's support for it is not safe to
 * assume, and a cover that silently loses half its colours is worse than one
 * computed in advance.
 */
function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return (
    '#' +
    [0, 1, 2]
      .map((i) => Math.round(ch(a, i) * (1 - t) + ch(b, i) * t))
      .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

/** Deep warm ink, as the cover template defines it — what darkens a tone. */
const SHADE = '#14161A'

/**
 * The colours a figure is drawn in.
 *
 * The compositions ask for six entries, and the first attempt at restraint
 * handed them the two inks padded out with the flat ground. That was worse
 * than the rainbow in a different way: the ground read as *holes* punched in
 * the picture rather than as part of it, and a stack of bands came out looking
 * unfinished.
 *
 * So the six are six *tones* of two hues — each ink, each ink lightened toward
 * the ground, one blend of the pair, and one deepened. Neighbours differ
 * enough that hard stops still read as separate bands; nothing in the set is a
 * third colour. That is what makes a two-ink cover look composed instead of
 * either garish or empty.
 */
export function rampFor(scheme: Scheme, length = 6, rotate = 0): string[] {
  const [a, b] = scheme.inks
  const A = INKS[a]
  const B = INKS[b]
  const ground = GROUNDS[scheme.ground]
  const tones = [
    A,
    B,
    mix(A, ground, 0.42),
    mix(A, B, 0.5),
    mix(B, ground, 0.32),
    mix(A, SHADE, 0.3),
  ]
  // Rotated by the issue, so two issues that genuinely belong to the same
  // scheme — several of these are about systems and measurement, and should
  // be — do not print the identical cover. Same family, different lead tone.
  // Colour is chosen by subject; which tone leads is not a claim about the
  // subject, so this is free to vary.
  const from = ((Math.trunc(rotate) % tones.length) + tones.length) % tones.length
  return Array.from({ length }, (_, i) => tones[(from + i) % tones.length])
}

// ── Asking the model to apply the brief ──────────────────────────────────────

/** The same small model that names the issue; this costs about as much. */
export const ART_MODEL = 'claude-haiku-4-5'

export interface ChooseCoverOptions {
  issueNumber: number
  issueName: string
  toc: TocEntry[]
  apiKey?: string | null
  /** Injected by the tests. */
  client?: Anthropic
}

/**
 * Choose this issue's cover from its contents.
 *
 * Falls back to the rotation on every failure — no key, an empty issue, a
 * model that answered with a paragraph, a network that was not there. A cover
 * nobody could choose is still a cover, and an issue that cannot be printed
 * because a colour could not be picked would be an absurd thing to build.
 */
export async function chooseCover(opts: ChooseCoverOptions): Promise<CoverBrief> {
  const { issueNumber, issueName, toc, apiKey } = opts
  if (!apiKey || toc.length === 0) return fallbackBrief(issueNumber)

  const client = opts.client ?? new Anthropic({ apiKey })
  try {
    const response = await client.messages.create({
      model: ART_MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: coverBriefPrompt(issueName, toc) }],
    })
    const text = response.content.find((b) => b.type === 'text')?.text ?? ''
    return parseCoverBrief(text) ?? fallbackBrief(issueNumber)
  } catch (err) {
    console.error(`press/art: falling back to the rotation: ${(err as Error).message}`)
    return fallbackBrief(issueNumber)
  }
}
