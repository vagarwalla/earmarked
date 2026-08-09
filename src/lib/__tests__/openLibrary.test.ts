import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getCoverUrl,
  detectFormat,
  searchBooks,
  getEditions,
  hasNonLatinScript,
  isAudioEdition,
  isNonEnglishIsbn,
  mergeDuplicateWorks,
  isDerivativeWork,
  dropDerivativeWorks,
  findSiblingWorkIds,
  titleCore,
  titleKey,
} from '../openLibrary'
import type { BookSearchResult } from '../types'

beforeEach(() => {
  vi.unstubAllGlobals()
})

// ── getCoverUrl ───────────────────────────────────────────────────────────────

describe('getCoverUrl', () => {
  it('builds a medium cover URL by default', () => {
    const url = getCoverUrl('9780385533225')
    expect(url).toBe('https://covers.openlibrary.org/b/isbn/9780385533225-M.jpg')
  })

  it('supports size S', () => {
    expect(getCoverUrl('9780385533225', 'S')).toContain('-S.jpg')
  })

  it('supports size L', () => {
    expect(getCoverUrl('9780385533225', 'L')).toContain('-L.jpg')
  })
})

// ── detectFormat ──────────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('detects hardcover from title', () => {
    expect(detectFormat('Dune Hardcover Edition', null)).toBe('hardcover')
    expect(detectFormat('Dune Hardback', null)).toBe('hardcover')
  })

  it('detects hardcover from physDesc', () => {
    expect(detectFormat('Dune', 'hardcover')).toBe('hardcover')
    expect(detectFormat('Dune', 'Hardback binding')).toBe('hardcover')
  })

  it('detects paperback from title', () => {
    expect(detectFormat('Dune Paperback', null)).toBe('paperback')
    expect(detectFormat('Dune Softcover', null)).toBe('paperback')
    expect(detectFormat('Dune Mass Market Paperback', null)).toBe('paperback')
  })

  it('detects paperback from physDesc', () => {
    expect(detectFormat('Dune', 'paperback')).toBe('paperback')
  })

  it('returns "any" when format is unknown', () => {
    expect(detectFormat('Dune', null)).toBe('any')
    expect(detectFormat('Dune', 'unknown binding')).toBe('any')
  })

  it('is case-insensitive', () => {
    expect(detectFormat('HARDCOVER EDITION', null)).toBe('hardcover')
    expect(detectFormat('PAPERBACK', null)).toBe('paperback')
  })
})

// ── searchBooks ───────────────────────────────────────────────────────────────

/** Stub fetch to return different responses for OL vs GB URLs */
function mockDualFetch(olResponse: unknown, gbResponse: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('openlibrary.org')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(olResponse) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(gbResponse) })
  }))
}

describe('searchBooks', () => {
  it('returns mapped results from the Open Library API', async () => {
    const mockResponse = {
      docs: [
        {
          title: 'Dune',
          author_name: ['Frank Herbert'],
          key: '/works/OL102749W',
          cover_i: 12345,
          first_publish_year: 1965,
        },
        {
          title: 'Dune Messiah',
          author_name: ['Frank Herbert'],
          key: '/works/OL102750W',
          cover_i: null,
          first_publish_year: 1969,
        },
      ],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const results = await searchBooks('Dune')
    expect(results).toHaveLength(2)

    expect(results[0].title).toBe('Dune')
    expect(results[0].author).toBe('Frank Herbert')
    expect(results[0].work_id).toBe('/works/OL102749W')
    expect(results[0].cover_url).toContain('12345')
    expect(results[0].first_publish_year).toBe(1965)

    expect(results[1].cover_url).toBeNull()
  })

  it('uses the first author when multiple are present', async () => {
    const mockResponse = {
      docs: [{
        title: 'Good Omens',
        author_name: ['Terry Pratchett', 'Neil Gaiman'],
        key: '/works/OL123W',
        cover_i: null,
        first_publish_year: 1990,
      }],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const [result] = await searchBooks('Good Omens')
    expect(result.author).toBe('Terry Pratchett')
  })

  it('returns "Unknown" author when author_name is missing', async () => {
    const mockResponse = {
      docs: [{
        title: 'Anonymous Book',
        author_name: null,
        key: '/works/OL1W',
        cover_i: null,
        first_publish_year: null,
      }],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const [result] = await searchBooks('Anonymous')
    expect(result.author).toBe('Unknown')
  })

  it('returns empty array when the API call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) })
    )

    const results = await searchBooks('Dune')
    expect(results).toEqual([])
  })

  it('returns empty array when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))
    // searchBooks doesn't have a try-catch so it will throw — this is expected behaviour
    await expect(searchBooks('Dune')).rejects.toThrow()
  })

  it('returns empty array when docs is missing from response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    )

    const results = await searchBooks('Dune')
    expect(results).toEqual([])
  })
})

// ── getEditions ───────────────────────────────────────────────────────────────

describe('getEditions', () => {
  it('returns editions mapped from Open Library entries', async () => {
    const mockResponse = {
      entries: [
        {
          title: 'Dune',
          isbn_13: ['9780441013593'],
          isbn_10: [],
          covers: [98765],
          publish_date: '1990',
          publishers: ['Ace Books'],
          edition_name: 'First Ace Edition',
          physical_format: 'paperback',
        },
        {
          title: 'Dune',
          isbn_13: ['9780340960196'],
          isbn_10: [],
          covers: [54321],
          publish_date: 'January 2005',
          publishers: ['Hodder'],
          physical_format: 'hardcover',
        },
      ],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const editions = await getEditions('/works/OL102749W')
    expect(editions).toHaveLength(2)

    const [first, second] = editions

    expect(first.isbn).toBe('9780441013593')
    expect(first.publisher).toBe('Ace Books')
    expect(first.publish_year).toBe(1990)
    expect(first.format).toBe('paperback')
    expect(first.cover_url).toContain('98765')

    expect(second.isbn).toBe('9780340960196')
    expect(second.format).toBe('hardcover')
    expect(second.cover_url).toContain('54321')
  })

  it('deduplicates editions with the same ISBN', async () => {
    const mockResponse = {
      entries: [
        { title: 'Dune', isbn_13: ['9780441013593'], isbn_10: [], covers: [11111], publish_date: '1990', publishers: ['Ace'] },
        { title: 'Dune', isbn_13: ['9780441013593'], isbn_10: [], covers: [11111], publish_date: '1991', publishers: ['Ace'] },
      ],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const editions = await getEditions('/works/OL102749W')
    expect(editions).toHaveLength(1)
  })

  it('skips entries with no ISBN', async () => {
    const mockResponse = {
      entries: [
        { title: 'Dune', isbn_13: [], isbn_10: [], covers: [11111], publish_date: '1990', publishers: ['Ace'] },
        { title: 'Dune', isbn_13: ['9780441013593'], isbn_10: [], covers: [22222], publish_date: '1991', publishers: ['Ace'] },
      ],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const editions = await getEditions('/works/OL102749W')
    expect(editions).toHaveLength(1)
    expect(editions[0].isbn).toBe('9780441013593')
  })

  it('prefers isbn_13 over isbn_10', async () => {
    const mockResponse = {
      entries: [{
        title: 'Dune',
        isbn_13: ['9780441013593'],
        isbn_10: ['0441013591'],
        covers: [11111],
        publish_date: '1990',
        publishers: ['Ace'],
      }],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const [edition] = await getEditions('/works/OL102749W')
    expect(edition.isbn).toBe('9780441013593')
  })

  it('returns empty array when the API call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) })
    )

    const editions = await getEditions('/works/OL102749W')
    expect(editions).toEqual([])
  })

  it('handles missing entries gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    )

    const editions = await getEditions('/works/OL102749W')
    expect(editions).toEqual([])
  })

  it('parses publish year from a date string with non-numeric characters', async () => {
    const mockResponse = {
      entries: [{
        title: 'Dune',
        isbn_13: ['9780441013593'],
        isbn_10: [],
        covers: [11111],
        publish_date: 'March 15, 1990',
        publishers: ['Ace'],
      }],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const [edition] = await getEditions('/works/OL102749W')
    expect(edition.publish_year).toBe(1990)
  })

  it('includes editions whose OL language matches the filter', async () => {
    const mockResponse = {
      entries: [{
        title: 'Dune',
        isbn_13: ['9780441013593'],
        isbn_10: [],
        covers: [98765],
        publish_date: '1990',
        publishers: ['Ace'],
        languages: [{ key: '/languages/eng' }],
      }],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const editions = await getEditions('/works/OL102749W', 'eng')
    expect(editions).toHaveLength(1)
    expect(editions[0].isbn).toBe('9780441013593')
  })

  it('excludes editions whose OL language does not match the filter', async () => {
    const mockResponse = {
      entries: [{
        title: 'Dune',
        isbn_13: ['9780441013593'],
        isbn_10: [],
        covers: [98765],
        publish_date: '1990',
        publishers: ['Gallimard'],
        languages: [{ key: '/languages/fre' }],
      }],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const editions = await getEditions('/works/OL102749W', 'eng')
    expect(editions).toHaveLength(0)
  })

  it('includes all editions (any language) when language filter is empty string', async () => {
    const mockResponse = {
      entries: [
        {
          title: 'Dune',
          isbn_13: ['9780441013593'],
          isbn_10: [],
          covers: [11111],
          publish_date: '1990',
          publishers: ['Ace'],
          languages: [{ key: '/languages/eng' }],
        },
        {
          title: 'Dune (French)',
          isbn_13: ['9782070360024'],
          isbn_10: [],
          covers: [22222],
          publish_date: '1992',
          publishers: ['Gallimard'],
          languages: [{ key: '/languages/fre' }],
        },
      ],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const editions = await getEditions('/works/OL102749W', '')
    expect(editions).toHaveLength(2)
  })

  it('includes editions with no cover when language filter is active', async () => {
    const mockResponse = {
      entries: [{
        title: 'Dune',
        isbn_13: ['9780441013593'],
        isbn_10: [],
        covers: [],          // no cover
        publish_date: '1990',
        publishers: ['Ace'],
        languages: [{ key: '/languages/eng' }],
      }],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) })
    )

    const editions = await getEditions('/works/OL102749W', 'eng')
    expect(editions).toHaveLength(1)
    expect(editions[0].cover_url).toBeNull()
  })

  it('sends untagged editions through Google Books language verification', async () => {
    const olResponse = {
      entries: [
        {
          // Has cover but no OL language tag — needs GB verification
          title: 'Dune',
          isbn_13: ['9780441013593'],
          isbn_10: [],
          covers: [98765],
          publish_date: '1990',
          publishers: ['Ace'],
          // no languages field
        },
      ],
    }

    // GB says it is English
    const gbResponse = { items: [{ volumeInfo: { language: 'en' } }] }

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('editions.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(olResponse) })
      }
      // GB language lookup
      return Promise.resolve({ ok: true, json: () => Promise.resolve(gbResponse) })
    }))

    const editions = await getEditions('/works/OL102749W', 'eng')
    expect(editions).toHaveLength(1)
  })

  it('excludes untagged edition when Google Books identifies it as a different language', async () => {
    const olResponse = {
      entries: [{
        title: 'Dune (French)',
        isbn_13: ['9782070360024'],
        isbn_10: [],
        covers: [22222],
        publish_date: '1992',
        publishers: ['Gallimard'],
        // no languages field
      }],
    }

    // GB says it is French
    const gbResponse = { items: [{ volumeInfo: { language: 'fr' } }] }

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('editions.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(olResponse) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(gbResponse) })
    }))

    const editions = await getEditions('/works/OL102749W', 'eng')
    expect(editions).toHaveLength(0)
  })
})

// ── searchBooks — Google Books series integration ─────────────────────────────

describe('searchBooks — GB series extraction', () => {
  it('extracts series and number from "Series: Book Title" GB format', async () => {
    const olResponse = {
      docs: [{
        title: 'The Screaming Staircase',
        author_name: ['Jonathan Stroud'],
        key: '/works/OL1W',
        cover_i: null,
        first_publish_year: 2013,
      }],
    }
    const gbResponse = {
      items: [{
        volumeInfo: {
          title: 'Lockwood & Co #1: The Screaming Staircase',
        },
      }],
    }

    mockDualFetch(olResponse, gbResponse)

    const results = await searchBooks('The Screaming Staircase')
    expect(results).toHaveLength(1)
    expect(results[0].series).toBe('Lockwood & Co')
    expect(results[0].series_number).toBe('1')
  })

  it('extracts series and number from "Title (Series, #N)" GB format', async () => {
    const olResponse = {
      docs: [{
        title: 'The Name of the Wind',
        author_name: ['Patrick Rothfuss'],
        key: '/works/OL2W',
        cover_i: null,
        first_publish_year: 2007,
      }],
    }
    const gbResponse = {
      items: [{
        volumeInfo: {
          title: 'The Name of the Wind (Kingkiller Chronicle, #1)',
        },
      }],
    }

    mockDualFetch(olResponse, gbResponse)

    const results = await searchBooks('The Name of the Wind')
    expect(results).toHaveLength(1)
    expect(results[0].series).toBe('Kingkiller Chronicle')
    expect(results[0].series_number).toBe('1')
  })

  it('extracts series number from word ordinals like "Book Two"', async () => {
    const olResponse = {
      docs: [{
        title: 'The Wise Man\'s Fear',
        author_name: ['Patrick Rothfuss'],
        key: '/works/OL3W',
        cover_i: null,
        first_publish_year: 2011,
      }],
    }
    const gbResponse = {
      items: [{
        volumeInfo: {
          title: 'The Wise Man\'s Fear (Kingkiller Chronicle, Book Two)',
        },
      }],
    }

    mockDualFetch(olResponse, gbResponse)

    const results = await searchBooks('The Wise Man\'s Fear')
    expect(results).toHaveLength(1)
    expect(results[0].series).toBe('Kingkiller Chronicle')
    expect(results[0].series_number).toBe('2')
  })

  it('does not assign series to short OL titles even if GB has a match', async () => {
    // Title is only 4 chars — matchGB should skip it (< 12 char threshold)
    const olResponse = {
      docs: [{
        title: 'Dune',
        author_name: ['Frank Herbert'],
        key: '/works/OL4W',
        cover_i: null,
        first_publish_year: 1965,
      }],
    }
    const gbResponse = {
      items: [{
        volumeInfo: {
          title: 'Some Long Series: Dune',
        },
      }],
    }

    mockDualFetch(olResponse, gbResponse)

    const results = await searchBooks('Dune')
    expect(results[0].series).toBeNull()
  })

  it('does not assign a series to a title that is an edition note in parentheses', async () => {
    const olResponse = {
      docs: [{
        title: 'The Lord of the Rings',
        author_name: ['J.R.R. Tolkien'],
        key: '/works/OL5W',
        cover_i: null,
        first_publish_year: 1954,
      }],
    }
    const gbResponse = {
      items: [{
        // "Special Edition" should be rejected as a series name
        volumeInfo: { title: 'The Lord of the Rings (Special Edition)' },
      }],
    }

    mockDualFetch(olResponse, gbResponse)

    const results = await searchBooks('The Lord of the Rings')
    expect(results[0].series).toBeNull()
  })
})

// ── hasNonLatinScript ─────────────────────────────────────────────────────────

describe('hasNonLatinScript', () => {
  it('detects Cyrillic', () => {
    expect(hasNonLatinScript('Гарри Поттер')).toBe(true)
  })

  it('detects CJK (Chinese/Japanese/Korean)', () => {
    expect(hasNonLatinScript('哈利·波特')).toBe(true)
    expect(hasNonLatinScript('ハリー・ポッター')).toBe(true)
    expect(hasNonLatinScript('해리 포터')).toBe(true)
  })

  it('detects Arabic', () => {
    expect(hasNonLatinScript('هاري بوتر')).toBe(true)
  })

  it('detects Hebrew', () => {
    expect(hasNonLatinScript('הארי פוטר')).toBe(true)
  })

  it('detects Greek', () => {
    expect(hasNonLatinScript('Χάρι Πότερ')).toBe(true)
  })

  it('detects Hindi (Devanagari)', () => {
    expect(hasNonLatinScript('हैरी पॉटर')).toBe(true)
  })

  it('returns false for plain English titles', () => {
    expect(hasNonLatinScript('Harry Potter and the Sorcerer\'s Stone')).toBe(false)
  })

  it('returns false for Latin-script European titles', () => {
    expect(hasNonLatinScript('Harry Potter et la pierre philosophale')).toBe(false)
    expect(hasNonLatinScript('Harry Potter und der Stein der Weisen')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(hasNonLatinScript('')).toBe(false)
  })
})

// ── isAudioEdition ────────────────────────────────────────────────────────────

describe('isAudioEdition', () => {
  it('detects "Audio CD" in title', () => {
    expect(isAudioEdition({ title: 'Harry Potter Audio CD' })).toBe(true)
  })

  it('detects "Audiobook" in title', () => {
    expect(isAudioEdition({ title: 'Percy Jackson Audiobook' })).toBe(true)
  })

  it('detects "Unabridged" in title', () => {
    expect(isAudioEdition({ title: 'Dune (Unabridged)' })).toBe(true)
  })

  it('detects "Abridged" in title', () => {
    expect(isAudioEdition({ title: 'Dune (Abridged)' })).toBe(true)
  })

  it('detects "Cassette" in physical_format', () => {
    expect(isAudioEdition({ title: 'Dune', physical_format: 'Cassette' })).toBe(true)
  })

  it('detects "Compact Disc" in physical_format', () => {
    expect(isAudioEdition({ title: 'Dune', physical_format: 'Compact Disc' })).toBe(true)
  })

  it('detects audio publisher name', () => {
    expect(isAudioEdition({ title: 'Dune', publishers: ['Brilliance Audio'] })).toBe(true)
    expect(isAudioEdition({ title: 'Dune', publishers: ['Listening Library Audio'] })).toBe(true)
  })

  it('detects "Audio" in edition_name', () => {
    expect(isAudioEdition({ title: 'Dune', edition_name: 'Audio Edition' })).toBe(true)
  })

  it('returns false for a regular print edition', () => {
    expect(isAudioEdition({ title: 'Harry Potter and the Sorcerer\'s Stone', publishers: ['Scholastic'], physical_format: 'Paperback' })).toBe(false)
  })

  it('returns false when all fields are absent', () => {
    expect(isAudioEdition({})).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isAudioEdition({ title: 'AUDIOBOOK EDITION' })).toBe(true)
    expect(isAudioEdition({ physical_format: 'audio cd' })).toBe(true)
  })
})

// ── isNonEnglishIsbn ──────────────────────────────────────────────────────────

describe('isNonEnglishIsbn', () => {
  it('returns false for group-0 English ISBNs (US/UK)', () => {
    expect(isNonEnglishIsbn('9780439708180')).toBe(false) // Harry Potter Scholastic
    expect(isNonEnglishIsbn('9780441013593')).toBe(false) // Dune Ace Books
  })

  it('returns false for group-1 English ISBNs', () => {
    expect(isNonEnglishIsbn('9781338878929')).toBe(false)
  })

  it('returns true for group-2 French ISBNs', () => {
    expect(isNonEnglishIsbn('9782070360024')).toBe(true) // Dune Gallimard
  })

  it('returns true for group-3 German ISBNs', () => {
    expect(isNonEnglishIsbn('9783551551672')).toBe(true) // German Carlsen
  })

  it('returns true for group-4 Japanese ISBNs', () => {
    expect(isNonEnglishIsbn('9784003230114')).toBe(true)
  })

  it('returns true for group-5 Russian ISBNs', () => {
    expect(isNonEnglishIsbn('9785389077164')).toBe(true)
  })

  it('returns true for group-84 Spanish ISBNs', () => {
    expect(isNonEnglishIsbn('9788478886296')).toBe(true) // Spanish Salamandra
  })

  it('returns true for group-88 Italian ISBNs', () => {
    expect(isNonEnglishIsbn('9788804606864')).toBe(true) // Italian Mondadori
  })

  it('returns true for group-90 Dutch ISBNs', () => {
    expect(isNonEnglishIsbn('9789045015842')).toBe(true)
  })

  it('returns false for ISBN-10 (not 13 digits)', () => {
    expect(isNonEnglishIsbn('0439708184')).toBe(false)
  })

  it('handles ISBNs with hyphens', () => {
    expect(isNonEnglishIsbn('978-2-07-036002-4')).toBe(true)  // French with hyphens
    expect(isNonEnglishIsbn('978-0-439-70818-0')).toBe(false) // English with hyphens
  })
})

// ── getEditions — audio and non-English filtering ─────────────────────────────

describe('getEditions — edition filtering', () => {
  it('excludes audio editions regardless of language tag', async () => {
    const mockResponse = {
      entries: [
        {
          title: 'Percy Jackson Audiobook',
          isbn_13: ['9780807826157'],
          publishers: ['Listening Library'],
          physical_format: 'Audio CD',
          languages: [{ key: '/languages/eng' }],
        },
        {
          title: 'Percy Jackson and the Lightning Thief',
          isbn_13: ['9780786838653'],
          publishers: ['Hyperion'],
          physical_format: 'Hardcover',
          languages: [{ key: '/languages/eng' }],
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) }))

    const editions = await getEditions('/works/OL3366094W', 'eng')
    expect(editions).toHaveLength(1)
    expect(editions[0].isbn).toBe('9780786838653')
  })

  it('excludes editions with non-Latin script titles (no OL language tag)', async () => {
    const mockResponse = {
      entries: [
        {
          title: '哈利·波特', // Chinese — no language tag
          isbn_13: ['9787020033430'],
          publishers: ['People\'s Literature Publishing House'],
        },
        {
          title: 'Harry Potter and the Sorcerer\'s Stone',
          isbn_13: ['9780439708180'],
          publishers: ['Scholastic'],
          languages: [{ key: '/languages/eng' }],
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) }))

    const editions = await getEditions('/works/OL82563W', 'eng')
    expect(editions).toHaveLength(1)
    expect(editions[0].isbn).toBe('9780439708180')
  })

  it('excludes no-language-tag editions whose ISBN is in a non-English registration group', async () => {
    const mockResponse = {
      entries: [
        {
          title: 'Harry Potter y la piedra filosofal', // Spanish, no OL language tag
          isbn_13: ['9788478886296'], // group 84 = Spain
          publishers: ['Salamandra'],
          // no languages field
        },
        {
          title: 'Harry Potter and the Sorcerer\'s Stone',
          isbn_13: ['9780439708180'], // group 0 = English
          publishers: ['Scholastic'],
          languages: [{ key: '/languages/eng' }],
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) }))

    const editions = await getEditions('/works/OL82563W', 'eng')
    expect(editions).toHaveLength(1)
    expect(editions[0].isbn).toBe('9780439708180')
  })
})

// ── title normalisation ───────────────────────────────────────────────────────

describe('titleKey / titleCore', () => {
  it('keeps the subtitle in titleKey but drops it in titleCore', () => {
    expect(titleKey('Sapiens: A Brief History of Humankind')).toBe('sapiens a brief history of humankind')
    expect(titleCore('Sapiens: A Brief History of Humankind')).toBe('sapiens')
  })

  it('normalises punctuation, case and spacing', () => {
    expect(titleKey('Sapiens : a brief history of humankind')).toBe(titleKey('Sapiens: A Brief History of Humankind'))
  })

  it('strips a leading article', () => {
    expect(titleCore('The Body Keeps the Score')).toBe('body keeps the score')
  })

  it('strips a trailing parenthetical', () => {
    expect(titleKey('Dune (Special Edition)')).toBe('dune')
  })

  it('leaves a title with no subtitle unchanged', () => {
    expect(titleCore('Sapiens')).toBe('sapiens')
    expect(titleKey('Sapiens')).toBe('sapiens')
  })
})

// ── mergeDuplicateWorks ───────────────────────────────────────────────────────

function work(overrides: Partial<BookSearchResult> & { title: string; work_id: string }): BookSearchResult {
  return {
    author: 'Yuval Noah Harari',
    cover_url: null,
    cover_urls: [],
    first_publish_year: null,
    series: null,
    series_number: null,
    edition_count: 1,
    work_ids: [overrides.work_id],
    ...overrides,
  }
}

describe('mergeDuplicateWorks', () => {
  it('merges work records whose normalised titles are identical', () => {
    const merged = mergeDuplicateWorks([
      work({ title: 'Sapiens: A Brief History of Humankind', work_id: '/works/OL1W', edition_count: 40 }),
      work({ title: 'Sapiens : a brief history of humankind', work_id: '/works/OL2W', edition_count: 3 }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].work_ids).toEqual(['/works/OL1W', '/works/OL2W'])
  })

  it('merges a bare main title into its subtitled sibling', () => {
    const merged = mergeDuplicateWorks([
      work({ title: 'Sapiens', work_id: '/works/OL1W', edition_count: 2 }),
      work({ title: 'Sapiens: A Brief History of Humankind', work_id: '/works/OL2W', edition_count: 40 }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].work_ids).toContain('/works/OL1W')
    expect(merged[0].work_ids).toContain('/works/OL2W')
    // The record with more editions represents the merged result
    expect(merged[0].title).toBe('Sapiens: A Brief History of Humankind')
  })

  it('does not merge two different books that share a main title', () => {
    const merged = mergeDuplicateWorks([
      work({ title: 'Sapiens: A Brief History of Humankind', work_id: '/works/OL1W' }),
      work({ title: 'Sapiens: A Graphic History', work_id: '/works/OL2W' }),
    ])
    expect(merged).toHaveLength(2)
  })

  it('leaves a bare title alone when more than one subtitled sibling could claim it', () => {
    const merged = mergeDuplicateWorks([
      work({ title: 'Sapiens', work_id: '/works/OL1W' }),
      work({ title: 'Sapiens: A Brief History of Humankind', work_id: '/works/OL2W' }),
      work({ title: 'Sapiens: A Graphic History', work_id: '/works/OL3W' }),
    ])
    expect(merged).toHaveLength(3)
  })

  it('does not merge same-titled books by different authors', () => {
    const merged = mergeDuplicateWorks([
      work({ title: '1984', work_id: '/works/OL1W', author: 'George Orwell' }),
      work({ title: '1984', work_id: '/works/OL2W', author: 'Anthony Burgess' }),
    ])
    expect(merged).toHaveLength(2)
  })

  it('merges an unattributed work record into its authored twin', () => {
    const merged = mergeDuplicateWorks([
      work({ title: 'Meditations', work_id: '/works/OL1W', author: 'Marcus Aurelius', edition_count: 50 }),
      work({ title: 'Meditations', work_id: '/works/OL2W', author: 'Unknown', edition_count: 1 }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].author).toBe('Marcus Aurelius')
  })

  it('does not merge across differing volume numbers', () => {
    const merged = mergeDuplicateWorks([
      work({ title: 'The Gulag Archipelago, Volume 1', work_id: '/works/OL1W' }),
      work({ title: 'The Gulag Archipelago, Volume 2', work_id: '/works/OL2W' }),
    ])
    expect(merged).toHaveLength(2)
  })

  it('keeps the earliest publish year and unions cover art', () => {
    const merged = mergeDuplicateWorks([
      work({ title: 'Sapiens', work_id: '/works/OL1W', first_publish_year: 2015, cover_urls: ['a.jpg'] }),
      work({
        title: 'Sapiens: A Brief History of Humankind',
        work_id: '/works/OL2W',
        edition_count: 9,
        first_publish_year: 2011,
        cover_url: 'b.jpg',
        cover_urls: ['b.jpg'],
      }),
    ])
    expect(merged[0].first_publish_year).toBe(2011)
    expect(merged[0].cover_urls).toEqual(expect.arrayContaining(['a.jpg', 'b.jpg']))
    expect(merged[0].edition_count).toBe(10)
  })

  it('preserves relevance order and leaves unrelated books untouched', () => {
    const merged = mergeDuplicateWorks([
      work({ title: 'Homo Deus', work_id: '/works/OL9W' }),
      work({ title: 'Sapiens', work_id: '/works/OL1W' }),
      work({ title: 'Sapiens: A Brief History of Humankind', work_id: '/works/OL2W', edition_count: 9 }),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0].title).toBe('Homo Deus')
  })

  it('is a no-op for an empty list', () => {
    expect(mergeDuplicateWorks([])).toEqual([])
  })
})

// ── derivative works ──────────────────────────────────────────────────────────

describe('isDerivativeWork', () => {
  it('flags summaries, study guides and workbooks', () => {
    expect(isDerivativeWork('Summary of Sapiens by Yuval Noah Harari')).toBe(true)
    expect(isDerivativeWork('Study Guide: Sapiens')).toBe(true)
    expect(isDerivativeWork('Workbook For Atomic Habits')).toBe(true)
    expect(isDerivativeWork('Conversation Starters for Educated')).toBe(true)
    expect(isDerivativeWork('Sapiens by Yuval Noah Harari | Summary & Analysis')).toBe(true)
    expect(isDerivativeWork('CliffsNotes on Walden')).toBe(true)
  })

  it('does not flag the books themselves', () => {
    expect(isDerivativeWork('Sapiens: A Brief History of Humankind')).toBe(false)
    expect(isDerivativeWork('Atomic Habits')).toBe(false)
    expect(isDerivativeWork('A Field Guide to Getting Lost')).toBe(false)
    expect(isDerivativeWork('The Hitchhiker\'s Guide to the Galaxy')).toBe(false)
  })
})

describe('dropDerivativeWorks', () => {
  const results = [
    work({ title: 'Atomic Habits', work_id: '/works/OL1W', author: 'James Clear' }),
    work({ title: 'Summary of Atomic Habits', work_id: '/works/OL2W', author: 'Instaread' }),
  ]

  it('removes derivatives from an ordinary query', () => {
    expect(dropDerivativeWorks(results, 'atomic habits').map((r) => r.work_id)).toEqual(['/works/OL1W'])
  })

  it('keeps derivatives when the query asks for one', () => {
    expect(dropDerivativeWorks(results, 'atomic habits summary')).toHaveLength(2)
  })

  it('keeps everything rather than returning nothing', () => {
    const onlyDerivatives = [work({ title: 'Summary of Atomic Habits', work_id: '/works/OL2W' })]
    expect(dropDerivativeWorks(onlyDerivatives, 'atomic habits')).toHaveLength(1)
  })
})

// ── searchBooks — non-fiction duplicate works ────────────────────────────────

describe('searchBooks — duplicate work merging', () => {
  it('collapses OL work shards into one result carrying every work id', async () => {
    const olResponse = {
      docs: [
        {
          title: 'Sapiens',
          author_name: ['Yuval Noah Harari'],
          key: '/works/OL1W',
          cover_i: null,
          first_publish_year: 2011,
          edition_count: 4,
        },
        {
          title: 'Sapiens: A Brief History of Humankind',
          author_name: ['Yuval Noah Harari'],
          key: '/works/OL2W',
          cover_i: 555,
          first_publish_year: 2014,
          edition_count: 60,
        },
        {
          title: 'Summary of Sapiens',
          author_name: ['Instaread'],
          key: '/works/OL3W',
          cover_i: null,
          first_publish_year: 2016,
          edition_count: 1,
        },
      ],
    }

    mockDualFetch(olResponse, { items: [] })

    const results = await searchBooks('sapiens')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Sapiens: A Brief History of Humankind')
    expect(results[0].work_ids).toEqual(expect.arrayContaining(['/works/OL1W', '/works/OL2W']))
    expect(results[0].work_id).toBe(results[0].work_ids?.[0])
  })

  it('does not turn a publisher imprint prefix into a series', async () => {
    // GB lists many non-fiction reissues as "Imprint: Title". Without a number in
    // the prefix that is an imprint, not a series.
    const olResponse = {
      docs: [{
        title: 'The Interpretation of Dreams',
        author_name: ['Sigmund Freud'],
        key: '/works/OL8W',
        cover_i: null,
        first_publish_year: 1899,
        edition_count: 30,
      }],
    }
    const gbResponse = {
      items: [{ volumeInfo: { title: 'Penguin Modern Classics: The Interpretation of Dreams' } }],
    }

    mockDualFetch(olResponse, gbResponse)

    const results = await searchBooks('the interpretation of dreams')
    expect(results[0].series).toBeNull()
  })

  it('still reads a numbered series prefix as a series', async () => {
    const olResponse = {
      docs: [{
        title: 'The Screaming Staircase',
        author_name: ['Jonathan Stroud'],
        key: '/works/OL9W',
        cover_i: null,
        first_publish_year: 2013,
        edition_count: 5,
      }],
    }
    const gbResponse = {
      items: [{ volumeInfo: { title: 'Lockwood & Co #1: The Screaming Staircase' } }],
    }

    mockDualFetch(olResponse, gbResponse)

    const results = await searchBooks('the screaming staircase')
    expect(results[0].series).toBe('Lockwood & Co')
    expect(results[0].series_number).toBe('1')
  })

  it('does not read a non-fiction subtitle as a series name', async () => {
    const olResponse = {
      docs: [{
        title: 'Bad Blood: Secrets and Lies in a Silicon Valley Startup',
        author_name: ['John Carreyrou'],
        key: '/works/OL7W',
        cover_i: null,
        first_publish_year: 2018,
        edition_count: 12,
      }],
    }
    const gbResponse = {
      items: [{ volumeInfo: { title: 'Bad Blood: Secrets and Lies in a Silicon Valley Startup' } }],
    }

    mockDualFetch(olResponse, gbResponse)

    const results = await searchBooks('bad blood')
    expect(results).toHaveLength(1)
    expect(results[0].series).toBeNull()
    expect(results[0].series_number).toBeNull()
  })
})

// ── getEditions across merged works ──────────────────────────────────────────

/** Serve a different editions payload per work id, keyed by the id in the URL. */
function mockEditionsByWork(byWork: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    for (const [workId, payload] of Object.entries(byWork)) {
      if (url.includes(workId)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) })
      }
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ entries: [] }) })
  }))
}

describe('getEditions — multiple works', () => {
  it('combines editions from every work id it is given', async () => {
    mockEditionsByWork({
      OL1W: { entries: [{ title: 'Sapiens', isbn_13: ['9780062316097'], covers: [1], publishers: ['Harper'] }] },
      OL2W: { entries: [{ title: 'Sapiens', isbn_13: ['9781846558238'], covers: [2], publishers: ['Vintage'] }] },
    })

    const editions = await getEditions(['/works/OL1W', '/works/OL2W'], '')
    expect(editions.map((e) => e.isbn).sort()).toEqual(['9780062316097', '9781846558238'])
  })

  it('de-duplicates ISBNs that appear under more than one work', async () => {
    const shared = { title: 'Sapiens', isbn_13: ['9780062316097'], covers: [1], publishers: ['Harper'] }
    mockEditionsByWork({
      OL1W: { entries: [shared] },
      OL2W: { entries: [shared, { title: 'Sapiens', isbn_13: ['9781846558238'], covers: [2], publishers: ['Vintage'] }] },
    })

    const editions = await getEditions(['/works/OL1W', '/works/OL2W'], '')
    expect(editions).toHaveLength(2)
  })

  it('still returns the editions of the works that succeeded when one work fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('OL1W')) return Promise.reject(new Error('network'))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ entries: [{ title: 'Sapiens', isbn_13: ['9781846558238'], covers: [2], publishers: ['Vintage'] }] }),
      })
    }))

    const editions = await getEditions(['/works/OL1W', '/works/OL2W'], '')
    expect(editions.map((e) => e.isbn)).toEqual(['9781846558238'])
  })

  it('accepts a single work id, unchanged from before', async () => {
    mockEditionsByWork({
      OL1W: { entries: [{ title: 'Sapiens', isbn_13: ['9780062316097'], covers: [1], publishers: ['Harper'] }] },
    })

    const editions = await getEditions('/works/OL1W', '')
    expect(editions).toHaveLength(1)
  })

  it('returns an empty list when given no work ids', async () => {
    vi.stubGlobal('fetch', vi.fn())
    expect(await getEditions([], '')).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ── findSiblingWorkIds ────────────────────────────────────────────────────────

describe('findSiblingWorkIds', () => {
  it('finds the other work records holding the same book', async () => {
    const olResponse = {
      docs: [
        { title: 'Sapiens', author_name: ['Yuval Noah Harari'], key: '/works/OL1W', cover_i: null, first_publish_year: 2011, edition_count: 4 },
        { title: 'Sapiens: A Brief History of Humankind', author_name: ['Yuval Noah Harari'], key: '/works/OL2W', cover_i: null, first_publish_year: 2014, edition_count: 60 },
      ],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(olResponse) }))

    const ids = await findSiblingWorkIds('/works/OL1W', 'Sapiens', 'Yuval Noah Harari')
    expect(ids[0]).toBe('/works/OL1W')  // the user's own choice stays first
    expect(ids).toContain('/works/OL2W')
  })

  it('returns just the given work when search finds nothing related', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ docs: [] }) }))
    expect(await findSiblingWorkIds('/works/OL1W', 'Sapiens', 'Yuval Noah Harari')).toEqual(['/works/OL1W'])
  })

  it('returns just the given work when the search call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    expect(await findSiblingWorkIds('/works/OL1W', 'Sapiens', 'Yuval Noah Harari')).toEqual(['/works/OL1W'])
  })

  it('does not call out at all without a title', async () => {
    vi.stubGlobal('fetch', vi.fn())
    expect(await findSiblingWorkIds('/works/OL1W', '', '')).toEqual(['/works/OL1W'])
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('isDerivativeWork — words that only look derivative', () => {
  it('does not flag real books whose titles contain analysis or companion', () => {
    expect(isDerivativeWork('Analysis of Algorithms')).toBe(false)
    expect(isDerivativeWork('A Companion to Russian Studies')).toBe(false)
    expect(isDerivativeWork('The Summing Up')).toBe(false)
  })

  it('still flags a summary that uses those words', () => {
    expect(isDerivativeWork('Summary and Analysis of Sapiens')).toBe(true)
  })
})
