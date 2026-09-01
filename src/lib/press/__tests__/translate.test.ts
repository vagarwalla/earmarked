import { describe, expect, it, vi } from 'vitest'
import {
  applySegments,
  chunkSegments,
  collectSegments,
  detectArticleLanguage,
  mapArticleText,
  translateArticle,
  TranslationError,
  TRANSLATION_MODEL,
} from '../translate'
import type { Article } from '../types'

function article(overrides: Partial<Article> = {}): Article {
  return {
    title: 'Заглавие',
    byline: 'Иван Иванов',
    sourceName: 'Журнал',
    url: 'https://example.org/a',
    publishedAt: '2024-01-01',
    dek: 'Подзаголовок',
    lead: null,
    blocks: [
      { type: 'heading', level: 2, text: 'Раздел' },
      { type: 'para', html: 'Первый <em>абзац</em>.' },
      { type: 'quote', html: 'Цитата', attribution: 'Кто-то' },
      { type: 'list', ordered: false, items: ['раз', 'два'] },
      { type: 'rule' },
    ],
    footnotes: [{ marker: '1', html: 'Примечание' }],
    ...overrides,
  }
}

describe('collectSegments', () => {
  it('collects every translatable string and no others', () => {
    expect(collectSegments(article())).toEqual([
      'Заглавие',
      'Подзаголовок',
      'Раздел',
      'Первый <em>абзац</em>.',
      'Цитата',
      'Кто-то',
      'раз',
      'два',
      'Примечание',
    ])
  })

  // A byline is a person and a sourceName is a masthead. Translating either
  // renames a real human being in print.
  it('leaves the byline, the publication and the URL alone', () => {
    const out = mapArticleText(article(), () => 'TRANSLATED')
    expect(out.byline).toBe('Иван Иванов')
    expect(out.sourceName).toBe('Журнал')
    expect(out.url).toBe('https://example.org/a')
  })

  it('reads image alt text and captions, which the reader does see', () => {
    const withFigure = article({
      blocks: [
        {
          type: 'figure',
          image: {
            path: 'p.jpg',
            alt: 'Подпись',
            caption: 'Фото',
            width: null,
            height: null,
            orientation: 'landscape',
          },
        },
      ],
      footnotes: undefined,
    })
    expect(collectSegments(withFigure)).toEqual(['Заглавие', 'Подзаголовок', 'Подпись', 'Фото'])
  })
})

describe('applySegments', () => {
  it('puts translations back in the slots they came from', () => {
    const source = article()
    const out = applySegments(
      source,
      collectSegments(source).map((s) => `[${s}]`),
    )
    expect(out.title).toBe('[Заглавие]')
    expect(out.blocks[1]).toEqual({ type: 'para', html: '[Первый <em>абзац</em>.]' })
    expect(out.blocks[3]).toEqual({ type: 'list', ordered: false, items: ['[раз]', '[два]'] })
    expect(out.footnotes).toEqual([{ marker: '1', html: '[Примечание]' }])
  })

  it('preserves structure that is never sent to the model', () => {
    const source = article()
    const out = applySegments(source, collectSegments(source).map(() => 'x'))
    expect(out.blocks.map((b) => b.type)).toEqual(source.blocks.map((b) => b.type))
    expect(out.footnotes?.[0].marker).toBe('1')
  })

  // Both directions matter: a short list would leave the tail untranslated,
  // a long one means the model split a segment and every slot after it shifts.
  it('refuses a translation with too few segments', () => {
    expect(() => applySegments(article(), ['one'])).toThrow(TranslationError)
  })

  it('refuses a translation with too many segments', () => {
    const source = article()
    const tooMany = [...collectSegments(source).map(() => 'x'), 'extra']
    expect(() => applySegments(source, tooMany)).toThrow(TranslationError)
  })
})

describe('chunkSegments', () => {
  it('fills chunks up to the character budget', () => {
    expect(chunkSegments(['aaa', 'bbb', 'ccc', 'ddd'], 6)).toEqual([
      ['aaa', 'bbb'],
      ['ccc', 'ddd'],
    ])
  })

  it('never splits a single oversized segment', () => {
    const huge = 'x'.repeat(50)
    expect(chunkSegments(['a', huge, 'b'], 10)).toEqual([['a'], [huge], ['b']])
  })

  it('returns nothing for nothing', () => {
    expect(chunkSegments([], 10)).toEqual([])
  })
})

describe('translateArticle', () => {
  function clientReturning(...responses: unknown[]) {
    const parse = vi.fn()
    for (const r of responses) parse.mockResolvedValueOnce(r)
    return { client: { messages: { parse } } as never, parse }
  }

  const ok = (segments: string[]) => ({
    stop_reason: 'end_turn',
    parsed_output: { segments },
  })

  it('translates an article and records what it did', async () => {
    const source = article()
    const { client } = clientReturning(ok(collectSegments(source).map((s) => `EN:${s}`)))

    const out = await translateArticle({
      article: source,
      sourceLanguage: 'Russian',
      apiKey: 'k',
      client,
      now: () => new Date('2026-09-01T12:00:00Z'),
    })

    expect(out.title).toBe('EN:Заглавие')
    expect(out.translation).toEqual({
      sourceLanguage: 'Russian',
      model: TRANSLATION_MODEL,
      translatedAt: '2026-09-01T12:00:00.000Z',
    })
  })

  it('stitches several chunks back into one article', async () => {
    const source = article()
    const segments = collectSegments(source)
    const chunks = chunkSegments(segments, 12)
    expect(chunks.length).toBeGreaterThan(1)
    const { client, parse } = clientReturning(
      ...chunks.map((c) => ok(c.map((s) => `EN:${s}`))),
    )

    const out = await translateArticle({
      article: source,
      sourceLanguage: 'Russian',
      apiKey: 'k',
      client,
      chunkChars: 12,
      now: () => new Date(0),
    })

    expect(parse).toHaveBeenCalledTimes(chunks.length)
    expect(out.title).toBe('EN:Заглавие')
    expect(out.footnotes).toEqual([{ marker: '1', html: 'EN:Примечание' }])
  })

  // The whole design rests on this: a partial translation must never survive.
  it('throws when a chunk comes back the wrong length', async () => {
    const { client } = clientReturning(ok(['only one']))
    await expect(
      translateArticle({ article: article(), sourceLanguage: 'Russian', apiKey: 'k', client }),
    ).rejects.toThrow(TranslationError)
  })

  it('throws when the model declines', async () => {
    const { client } = clientReturning({
      stop_reason: 'refusal',
      stop_details: { category: 'other' },
      parsed_output: null,
    })
    await expect(
      translateArticle({ article: article(), sourceLanguage: 'Russian', apiKey: 'k', client }),
    ).rejects.toThrow(/declined/)
  })

  it('throws when the output was cut off rather than returning half a piece', async () => {
    const { client } = clientReturning({ stop_reason: 'max_tokens', parsed_output: null })
    await expect(
      translateArticle({ article: article(), sourceLanguage: 'Russian', apiKey: 'k', client }),
    ).rejects.toThrow(/cut off/)
  })

  it('throws without an API key instead of printing the original', async () => {
    await expect(
      translateArticle({ article: article(), sourceLanguage: 'Russian', apiKey: null }),
    ).rejects.toThrow(TranslationError)
  })
})

describe('detectArticleLanguage', () => {
  const clientSaying = (text: string) =>
    ({
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text }] }) },
    }) as never

  it('reads a language name out of the reply', async () => {
    expect(await detectArticleLanguage({ article: article(), apiKey: 'k', client: clientSaying('Russian') })).toBe(
      'Russian',
    )
  })

  it('tolerates the model dressing its answer up', async () => {
    expect(
      await detectArticleLanguage({ article: article(), apiKey: 'k', client: clientSaying('"German."') }),
    ).toBe('German')
  })

  // Null means "do not translate", so a junk answer must not become a language.
  it('returns null rather than guess', async () => {
    expect(
      await detectArticleLanguage({ article: article(), apiKey: 'k', client: clientSaying('¯\\_(ツ)_/¯') }),
    ).toBeNull()
  })

  it('returns null without an API key', async () => {
    expect(await detectArticleLanguage({ article: article(), apiKey: null })).toBeNull()
  })
})
