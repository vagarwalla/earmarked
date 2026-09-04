/**
 * press — translation.
 *
 * Some of the best essays in the collection are not in English. Eurozine is
 * valuable to us precisely because it translates long pieces out of Russian,
 * German and Polish partner journals — which is to say the scholarship exists,
 * and English-language discovery only ever sees the fraction someone else
 * chose to carry over. This module removes that dependency: an article is
 * translated on the way in, so everything downstream — measurement, the table
 * of contents, the issue name — reads English and nothing has to know.
 *
 * Two rules shape the design.
 *
 * **Structure is not translated, only text.** The renderer is fed inline HTML
 * it trusts, and a model asked to "translate this paragraph" will happily
 * reflow tags, drop a footnote marker, or helpfully merge two paragraphs. So
 * the article is flattened into a list of strings, the model sees only that
 * list, and the strings are put back exactly where they came from. Block
 * structure, image paths and footnote numbering cannot move because they are
 * never sent.
 *
 * **A partial translation is a failure, not a result.** Everything else in
 * press degrades gracefully — a failed issue name falls back to a date, a
 * failed image is dropped. This does not. Half a translation is an article
 * that prints as English until it abruptly is not, and there is no way for a
 * reader to tell that from an essay that quotes its sources in the original.
 * Every failure here throws.
 */

import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import type { Article, ArticleBlock, TranslationProvenance } from './types'

export type { TranslationProvenance }

/**
 * Translation is the one place in press where the model's output is the
 * product rather than a label on it, so this is not the cheap model naming
 * uses. Register, idiom and the difference between a scholar's hedge and a
 * flat claim all survive or die here.
 */
export const TRANSLATION_MODEL = 'claude-opus-5'

/** Language identification is a genuinely easy question; it gets the cheap model. */
export const DETECTION_MODEL = 'claude-haiku-4-5'

/**
 * Source characters per request. Well inside the output ceiling even when a
 * language expands under translation, and small enough that one refusal or
 * malformed response costs a chunk rather than an essay.
 */
export const CHUNK_CHARS = 6000

/** How much of the article the detector reads. The first page settles it. */
const DETECTION_SAMPLE_CHARS = 2000

export class TranslationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranslationError'
  }
}

// ── Flattening ───────────────────────────────────────────────────────────────

/**
 * Walk every translatable string in an article, in a fixed order, replacing
 * each with `fn`'s answer.
 *
 * Collection and re-application both go through this one function, which is
 * the point: two traversals that could drift apart would put the third
 * paragraph's translation into the second paragraph's slot, and produce a
 * plausible-looking essay that is quietly wrong. There is only one traversal.
 *
 * A byline is a person's name and a `sourceName` is a masthead; neither is
 * translated. Nor is the URL, obviously.
 */
export function mapArticleText(article: Article, fn: (text: string) => string): Article {
  const mapBlock = (block: ArticleBlock): ArticleBlock => {
    switch (block.type) {
      case 'heading':
        return { ...block, text: fn(block.text) }
      case 'para':
        return { ...block, html: fn(block.html) }
      case 'quote':
        return {
          ...block,
          html: fn(block.html),
          ...(block.attribution === undefined ? {} : { attribution: fn(block.attribution) }),
        }
      case 'list':
        return { ...block, items: block.items.map(fn) }
      case 'figure':
        return {
          ...block,
          image: {
            ...block.image,
            alt: block.image.alt === null ? null : fn(block.image.alt),
            caption: block.image.caption === null ? null : fn(block.image.caption),
          },
        }
      case 'rule':
        return block
    }
  }

  return {
    ...article,
    title: fn(article.title),
    dek: article.dek === null ? null : fn(article.dek),
    lead:
      article.lead === null
        ? null
        : {
            ...article.lead,
            alt: article.lead.alt === null ? null : fn(article.lead.alt),
            caption: article.lead.caption === null ? null : fn(article.lead.caption),
          },
    blocks: article.blocks.map(mapBlock),
    ...(article.footnotes === undefined
      ? {}
      : { footnotes: article.footnotes.map((n) => ({ ...n, html: fn(n.html) })) }),
  }
}

/** Every translatable string in the article, in traversal order. */
export function collectSegments(article: Article): string[] {
  const out: string[] = []
  mapArticleText(article, (text) => {
    out.push(text)
    return text
  })
  return out
}

/**
 * Put translated strings back where they came from.
 *
 * Throws rather than pad or truncate: a length mismatch means the traversal
 * and the translation disagree about what the article contains, and every way
 * of carrying on from there silently misplaces text.
 */
export function applySegments(article: Article, translated: string[]): Article {
  let i = 0
  const applied = mapArticleText(article, () => {
    if (i >= translated.length) {
      throw new TranslationError(
        `translation is short: expected ${collectSegments(article).length} segments, got ${translated.length}`,
      )
    }
    return translated[i++]
  })
  if (i !== translated.length) {
    throw new TranslationError(
      `translation is long: expected ${i} segments, got ${translated.length}`,
    )
  }
  return applied
}

/**
 * Split segments into request-sized runs.
 *
 * A single segment over the budget goes in a chunk of its own rather than
 * being cut — a paragraph split across two requests loses the antecedent of
 * every pronoun in its second half.
 */
export function chunkSegments(segments: string[], maxChars = CHUNK_CHARS): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let size = 0
  for (const segment of segments) {
    if (current.length > 0 && size + segment.length > maxChars) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(segment)
    size += segment.length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

// ── The model ────────────────────────────────────────────────────────────────

const SEGMENTS_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: { type: 'string' },
      description: 'The translated segments, in the same order as the input.',
    },
  },
  required: ['segments'],
  additionalProperties: false,
} as const

const SYSTEM_PROMPT = `You are translating a long-form essay for a printed magazine. The reader is intelligent and reads widely, but does not read the source language.

You will be given a JSON array of segments from one article — paragraphs, headings, list items, pull quotes, captions and footnotes, in the order they appear. Translate each into English and return them in the same order.

Rules:

1. Return exactly as many segments as you were given. Never merge two segments, never split one, never drop one, never add one. A segment that is already English, or is a bare numeral or a proper noun, comes back unchanged.
2. Segments may contain inline HTML — <em>, <a href="...">, <sup>, footnote markers. Reproduce every tag and attribute exactly as given, in the same order, translating only the human-readable text between them. Never add, remove or reorder a tag. Never translate a URL.
3. Translate as a translator of essays, not as a dictionary. Carry the argument, the register and the author's hedges. A sentence that is tentative in the original must be tentative in English; a polemical one must stay polemical. Prefer the natural English construction over the one that mirrors the source's word order.
4. Keep quoted material as quotation. If the source quotes a text that has a well-known published English version, use wording faithful to the original's sense rather than inventing a florid one.
5. Proper nouns, institutions and titles of works: use the established English form where one exists, otherwise transliterate conventionally. Do not gloss, and do not add explanations, brackets or translator's notes — there is nowhere on the page for them.
6. Translate nothing into commentary. You are not summarising, improving, shortening or annotating the essay.`

/**
 * Anything outside the Latin blocks and shared punctuation — Cyrillic, CJK,
 * Greek, Arabic, Devanagari. Deliberately crude: it only has to answer "would
 * this print".
 */
const NON_LATIN =
  // Written as escapes, not as the characters themselves. Spelled literally
  // this range starts with a NUL byte and contains several invisible format
  // characters, which makes the whole file binary to `file`, to grep and to
  // ripgrep — so every code search over the repo silently skipped translate.ts.
  // The ranges are: Latin and its diacritics (through Latin Extended-B and the
  // spacing modifiers), Latin Extended Additional, General Punctuation, and
  // the currency symbols.
  /[^\u0000-\u02FF\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20CF]/

/** Whether a string contains anything the magazine's fonts cannot set. */
export function needsRomanizing(value: string | null): boolean {
  return value !== null && NON_LATIN.test(value)
}

const NAMES_SCHEMA = {
  type: 'object',
  properties: {
    names: {
      type: 'array',
      items: { type: 'string' },
      description: 'The romanized names, in the same order as the input.',
    },
  },
  required: ['names'],
  additionalProperties: false,
} as const

/** The SDK surface these functions actually use, so tests can pass a stub. */
export type TranslationClient = Pick<Anthropic, 'messages'>

export interface DetectLanguageOptions {
  article: Article
  apiKey: string | null
  client?: TranslationClient
}

/**
 * The language an article is written in, as an English name — or `null` when
 * that cannot be established, which the caller must treat as "do not
 * translate" rather than as English.
 */
export async function detectArticleLanguage(opts: DetectLanguageOptions): Promise<string | null> {
  const { article, apiKey } = opts
  if (!apiKey) return null

  const sample = [article.title, article.dek ?? '', ...collectSegments(article)]
    .join('\n')
    .slice(0, DETECTION_SAMPLE_CHARS)
  if (sample.trim().length === 0) return null

  const client = opts.client ?? new Anthropic({ apiKey })
  try {
    const response = await client.messages.create({
      model: DETECTION_MODEL,
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content: `What language is this written in? Reply with the English name of the language and nothing else — "Russian", "German", "English".\n\n---\n${sample}`,
        },
      ],
    })
    const text = response.content.find((b) => b.type === 'text')?.text ?? ''
    const name = text.trim().replace(/[."']/g, '').split(/\s|\n/)[0] ?? ''
    return /^[A-Za-z]{3,}$/.test(name) ? name : null
  } catch (err) {
    console.error(`press/translate: language detection failed: ${(err as Error).message}`)
    return null
  }
}

async function translateChunk(
  client: TranslationClient,
  sourceLanguage: string,
  segments: string[],
): Promise<string[]> {
  const response = await client.messages.parse({
    model: TRANSLATION_MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Translate these ${segments.length} segments from ${sourceLanguage} into English. Return ${segments.length} segments.\n\n${JSON.stringify(segments, null, 1)}`,
      },
    ],
    output_config: { format: jsonSchemaOutputFormat(SEGMENTS_SCHEMA) },
  })

  if (response.stop_reason === 'refusal') {
    // `stop_details` is sent by the API but is not in this SDK version's types
    // yet, and the category is the whole diagnostic value of a refusal — worth
    // reading now and deleting the cast when the SDK catches up.
    const details = (response as { stop_details?: { category?: string | null } }).stop_details
    throw new TranslationError(
      `the model declined to translate a passage (${details?.category ?? 'no category given'})`,
    )
  }
  if (response.stop_reason === 'max_tokens') {
    throw new TranslationError(
      'translation was cut off by the output limit; retry with a smaller chunkChars',
    )
  }

  const parsed = response.parsed_output
  if (!parsed) throw new TranslationError('the model returned no parseable translation')
  const { segments: out } = parsed as { segments: string[] }
  if (out.length !== segments.length) {
    throw new TranslationError(
      `chunk came back the wrong length: sent ${segments.length}, got ${out.length}`,
    )
  }
  return out
}

/**
 * Romanize a byline or a masthead written in another script.
 *
 * This is not translation and is deliberately kept out of the segment pass: a
 * name must not be translated, or Иван Кузнецов prints as "John Smith". But it
 * cannot be left alone either — the magazine sets Georgia and Helvetica, which
 * have no CJK or Cyrillic, so an untouched byline prints as empty boxes. The
 * answer is the third thing: same name, Latin script.
 */
async function romanizeNames(
  client: TranslationClient,
  sourceLanguage: string,
  names: string[],
): Promise<string[]> {
  const response = await client.messages.parse({
    model: TRANSLATION_MODEL,
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: `Romanize these ${sourceLanguage} names into the Latin alphabet, so they can be set in a magazine that has no ${sourceLanguage} font.

Do not translate them — a personal name keeps its identity, it does not acquire an English equivalent. Use the spelling the person or publication uses in English if there is a well-known one, otherwise the standard romanization for the language. Give a person's name in the order an English-language magazine would print it. Return one romanization per input, in the same order.

${JSON.stringify(names, null, 1)}`,
      },
    ],
    output_config: { format: jsonSchemaOutputFormat(NAMES_SCHEMA) },
  })

  const parsed = response.parsed_output as { names: string[] } | null
  if (!parsed || parsed.names.length !== names.length) {
    throw new TranslationError(
      `romanization came back wrong: sent ${names.length}, got ${parsed?.names.length ?? 0}`,
    )
  }
  return parsed.names
}

export interface TranslateArticleOptions {
  article: Article
  /** English name of the language to translate from, e.g. "Russian". */
  sourceLanguage: string
  apiKey: string | null
  client?: TranslationClient
  /**
   * Source characters per request. Lower it for a language that expands a long
   * way under translation, or after a chunk has been cut off by the output
   * limit. Defaults to {@link CHUNK_CHARS}.
   */
  chunkChars?: number
  /** Injectable clock, so the provenance stamp is testable. */
  now?: () => Date
}

/**
 * Translate an article into English, structure untouched.
 *
 * Throws on any failure. See the note at the top of the file: there is no
 * useful halfway state for a translated article, so there is no fallback.
 */
export async function translateArticle(opts: TranslateArticleOptions): Promise<Article> {
  const { article, sourceLanguage, apiKey } = opts
  if (!apiKey) throw new TranslationError('no Anthropic API key, so nothing can be translated')

  const client = opts.client ?? new Anthropic({ apiKey })
  const segments = collectSegments(article)
  if (segments.length === 0) throw new TranslationError('article has no text to translate')

  const translated: string[] = []
  for (const chunk of chunkSegments(segments, opts.chunkChars ?? CHUNK_CHARS)) {
    translated.push(...(await translateChunk(client, sourceLanguage, chunk)))
  }

  let out = applySegments(article, translated)

  // The byline and the masthead were held back from the segment pass because
  // they must not be translated. They still have to be printable.
  const toRomanize: Array<'byline' | 'sourceName'> = (['byline', 'sourceName'] as const).filter(
    (field) => needsRomanizing(out[field]),
  )
  if (toRomanize.length > 0) {
    const romanized = await romanizeNames(
      client,
      sourceLanguage,
      toRomanize.map((field) => out[field] as string),
    )
    out = { ...out, ...Object.fromEntries(toRomanize.map((f, i) => [f, romanized[i]])) }
  }

  const now = opts.now ?? (() => new Date())
  return {
    ...out,
    translation: {
      sourceLanguage,
      model: TRANSLATION_MODEL,
      translatedAt: now().toISOString(),
    },
  }
}
