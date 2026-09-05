import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseGoodreadsUserId,
  parseShelvesFromHtml,
  parseGoodreadsShelfFromUrl,
  parseShelfRss,
  parseRssOwnerName,
  stripSeriesSuffix,
  fetchShelfBooks,
} from '../goodreadsShelf'

beforeEach(() => {
  vi.unstubAllGlobals()
})

// ── parseGoodreadsUserId ──────────────────────────────────────────────────────

describe('parseGoodreadsUserId', () => {
  it('accepts a bare numeric ID', () => {
    expect(parseGoodreadsUserId('12345')).toBe('12345')
    expect(parseGoodreadsUserId('  12345  ')).toBe('12345')
  })

  it('extracts the ID from a profile URL', () => {
    expect(parseGoodreadsUserId('https://www.goodreads.com/user/show/12345-jane-doe')).toBe('12345')
    expect(parseGoodreadsUserId('goodreads.com/user/show/98765')).toBe('98765')
  })

  it('extracts the ID from a shelf URL', () => {
    expect(parseGoodreadsUserId('https://www.goodreads.com/review/list/12345?shelf=read')).toBe('12345')
    expect(parseGoodreadsUserId('https://www.goodreads.com/review/list_rss/12345')).toBe('12345')
  })

  it('accepts an id-slug fragment', () => {
    expect(parseGoodreadsUserId('12345-jane-doe')).toBe('12345')
  })

  it('rejects garbage', () => {
    expect(parseGoodreadsUserId('')).toBeNull()
    expect(parseGoodreadsUserId('jane doe')).toBeNull()
    expect(parseGoodreadsUserId('https://example.com/user/show/123')).toBeNull()
  })
})

// ── stripSeriesSuffix ─────────────────────────────────────────────────────────

describe('stripSeriesSuffix', () => {
  it('strips "(Series, #N)" annotations', () => {
    expect(stripSeriesSuffix('The Golden Compass (His Dark Materials, #1)')).toBe('The Golden Compass')
    expect(stripSeriesSuffix('Dune (Dune #1)')).toBe('Dune')
  })

  it('strips "(Series Book N)" annotations', () => {
    expect(stripSeriesSuffix('The Fifth Season (The Broken Earth Book 1)')).toBe('The Fifth Season')
  })

  it('keeps parentheticals that are part of the title', () => {
    expect(stripSeriesSuffix('Betty (A Novel)')).toBe('Betty (A Novel)')
  })

  it('leaves plain titles alone', () => {
    expect(stripSeriesSuffix('Middlemarch')).toBe('Middlemarch')
  })
})

// ── parseGoodreadsShelfFromUrl ────────────────────────────────────────────────

describe('parseGoodreadsShelfFromUrl', () => {
  it('extracts a shelf from a ?shelf= URL', () => {
    expect(parseGoodreadsShelfFromUrl('https://www.goodreads.com/review/list/12345-jane?shelf=sociology')).toBe('sociology')
  })

  it('extracts a shelf from a ?tag= URL (newer My Books UI)', () => {
    expect(parseGoodreadsShelfFromUrl('https://www.goodreads.com/review/list/8008984-vaidehi?ref=nav_mybooks&tag=sociology')).toBe('sociology')
  })

  it('decodes encoded names', () => {
    expect(parseGoodreadsShelfFromUrl('?shelf=summer%20reads')).toBe('summer reads')
    expect(parseGoodreadsShelfFromUrl('?tag=summer+reads')).toBe('summer reads')
  })

  it('ignores the #ALL# pseudo-shelf and plain profile URLs', () => {
    expect(parseGoodreadsShelfFromUrl('?shelf=%23ALL%23')).toBeNull()
    expect(parseGoodreadsShelfFromUrl('https://www.goodreads.com/user/show/12345-jane')).toBeNull()
  })
})

// ── parseShelvesFromHtml ──────────────────────────────────────────────────────

const PROFILE_HTML = `
<div class="leftContainer">
  <h2>Bookshelves</h2>
  <div class="clearFloats">
    <a href="/review/list/12345?shelf=read">read&lrm; (142)</a>
    <a href="/review/list/12345?shelf=currently-reading">currently-reading&lrm; (3)</a>
    <a href="/review/list/12345?shelf=to-read">to-read&lrm; (1,057)</a>
    <a href="/review/list/12345?shelf=favorites&per_page=20">favorites&lrm; (28)</a>
    <a href="/review/list/12345?shelf=read">read&lrm; (142)</a>
  </div>
</div>`

// My Books sidebar style: custom shelves via tag= links, count outside the anchor
const MYBOOKS_HTML = `
<div class="userShelves">
  <a href="/review/list/12345?shelf=%23ALL%23">All</a> <span>(1,230)</span>
  <a href="/review/list/12345?shelf=read">read</a> <span class="greyText">(142)</span>
  <a href="/review/list/12345-vaidehi?ref=nav_mybooks&tag=sociology">sociology</a> <span>(23)</span>
  <a href="/review/list/12345?tag=summer+reads">summer reads</a>
  <a href="/review/list/12345?shelf=to-read">to-read</a> <span>(1,057)</span>
</div>`

describe('parseShelvesFromHtml', () => {
  it('parses profile-page shelf links with counts in the label, deduplicated', () => {
    const shelves = parseShelvesFromHtml(PROFILE_HTML)
    expect(shelves).toEqual([
      { name: 'read', count: 142 },
      { name: 'currently-reading', count: 3 },
      { name: 'to-read', count: 1057 },
      { name: 'favorites', count: 28 },
    ])
  })

  it('parses My Books sidebar links: tag= params, counts after the anchor, skips #ALL#', () => {
    const shelves = parseShelvesFromHtml(MYBOOKS_HTML)
    expect(shelves).toEqual([
      { name: 'read', count: 142 },
      { name: 'sociology', count: 23 },
      { name: 'summer reads', count: -1 },
      { name: 'to-read', count: 1057 },
    ])
  })

  it('does not let a count-less shelf steal the next shelf\'s count', () => {
    const shelves = parseShelvesFromHtml(MYBOOKS_HTML)
    expect(shelves.find((s) => s.name === 'summer reads')?.count).toBe(-1)
  })

  it('takes the count from a later sighting when the first link is bare', () => {
    // Real profiles link the built-in shelves twice: once bare in the page nav,
    // once with a count in the shelf list. Keeping only the first left the most
    //-used shelves showing no count at all.
    const html = `
      <a href="/review/list/12345?shelf=read">My Books</a>
      <a href="/review/list/12345?shelf=read">read&lrm; (628)</a>`
    expect(parseShelvesFromHtml(html)).toEqual([{ name: 'read', count: 628 }])
  })

  it('returns empty for HTML with no shelf links', () => {
    expect(parseShelvesFromHtml('<html><body>private profile</body></html>')).toEqual([])
  })
})

// ── parseShelfRss ─────────────────────────────────────────────────────────────

function rssItem(fields: Record<string, string>): string {
  const tags = Object.entries(fields)
    .map(([tag, value]) => `<${tag}>${value}</${tag}>`)
    .join('\n')
  return `<item>\n${tags}\n</item>`
}

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title><![CDATA[Jane's bookshelf: read]]></title>
  <link><![CDATA[https://www.goodreads.com/review/list_rss/12345?shelf=read]]></link>
  ${rssItem({
    title: '<![CDATA[The Secret History]]>',
    book_id: '29044',
    author_name: 'Donna Tartt',
    isbn: '0679410325',
    book_medium_image_url: '<![CDATA[https://i.gr-assets.com/images/S/photo.goodreads.com/books/1451554846l/29044._SY75_.jpg]]>',
  })}
  ${rssItem({
    title: '<![CDATA[The Golden Compass (His Dark Materials, #1)]]>',
    book_id: '119322',
    author_name: 'Philip Pullman',
    isbn: '',
    isbn13: '9780440418320',
    book_medium_image_url: '<![CDATA[https://s.gr-assets.com/assets/nophoto/book/50x75-a91bf249278a81aabab721ef782c4a74.png]]>',
  })}
  ${rssItem({
    title: '<![CDATA[Ebook With No Isbn]]>',
    book_id: '555',
    author_name: 'A. N. Author &amp; Friend',
    isbn: '',
  })}
</channel>
</rss>`

describe('parseShelfRss', () => {
  it('parses books with title, author, isbn, and full-size cover', () => {
    const books = parseShelfRss(RSS_XML)
    expect(books).toHaveLength(3)
    expect(books[0]).toEqual({
      goodreads_id: '29044',
      title: 'The Secret History',
      author: 'Donna Tartt',
      isbn: '0679410325',
      cover_url: 'https://i.gr-assets.com/images/S/photo.goodreads.com/books/1451554846l/29044.jpg',
    })
  })

  it('prefers isbn13, strips series suffix, and nulls nophoto covers', () => {
    const book = parseShelfRss(RSS_XML)[1]
    expect(book.title).toBe('The Golden Compass')
    expect(book.isbn).toBe('9780440418320')
    expect(book.cover_url).toBeNull()
  })

  it('handles missing isbn and cover, decodes entities', () => {
    const book = parseShelfRss(RSS_XML)[2]
    expect(book.isbn).toBeNull()
    expect(book.cover_url).toBeNull()
    expect(book.author).toBe('A. N. Author & Friend')
  })

  it('returns empty for a feed with no items', () => {
    expect(parseShelfRss('<rss><channel><title>empty</title></channel></rss>')).toEqual([])
  })
})

describe('parseRssOwnerName', () => {
  it('extracts the owner name from the channel title', () => {
    expect(parseRssOwnerName(RSS_XML)).toBe('Jane')
  })

  it('returns null when the pattern is absent', () => {
    expect(parseRssOwnerName('<rss><channel><title>whatever</title></channel></rss>')).toBeNull()
  })
})

// ── fetchShelves ──────────────────────────────────────────────────────────────

describe('fetchShelves', () => {
  it('reads the profile page, and only the profile page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => PROFILE_HTML })
    vi.stubGlobal('fetch', fetchMock)

    const { fetchShelves } = await import('../goodreadsShelf')
    const shelves = await fetchShelves('12345')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://www.goodreads.com/user/show/12345')
    expect(shelves.map((s) => s.name)).toEqual(['read', 'currently-reading', 'to-read', 'favorites'])
    expect(shelves.find((s) => s.name === 'read')?.count).toBe(142)
  })

  it('reports a 404 as not-found, because a private profile 404s the same way', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    const { fetchShelves, GoodreadsError } = await import('../goodreadsShelf')

    const err = await fetchShelves('12345').catch((e) => e)
    expect(err).toBeInstanceOf(GoodreadsError)
    expect(err.reason).toBe('not-found')
  })

  it('reports any other bad status as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const { fetchShelves } = await import('../goodreadsShelf')

    const err = await fetchShelves('12345').catch((e) => e)
    expect(err.reason).toBe('unreachable')
  })

  it('reports a network failure as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')))
    const { fetchShelves } = await import('../goodreadsShelf')

    const err = await fetchShelves('12345').catch((e) => e)
    expect(err.reason).toBe('unreachable')
  })

  it('returns no shelves rather than throwing when the page lists none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '<html>hi</html>' }))
    const { fetchShelves } = await import('../goodreadsShelf')
    expect(await fetchShelves('12345')).toEqual([])
  })
})

// ── fetchShelfBooks ───────────────────────────────────────────────────────────

function rssPage(items: string[]): string {
  return `<?xml version="1.0"?><rss><channel><title><![CDATA[Jane's bookshelf: read]]></title>${items.join('')}</channel></rss>`
}

describe('fetchShelfBooks', () => {
  it('paginates until a short page', async () => {
    const page1Items = Array.from({ length: 100 }, (_, i) =>
      rssItem({ title: `Book ${i}`, author_name: 'A', isbn: '', book_id: String(i) })
    )
    const page2Items = [rssItem({ title: 'Last Book', author_name: 'B', isbn: '', book_id: '999' })]

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => rssPage(page1Items) })
      .mockResolvedValueOnce({ ok: true, text: async () => rssPage(page2Items) })
    vi.stubGlobal('fetch', fetchMock)

    const { books, ownerName } = await fetchShelfBooks('12345', 'read')
    expect(books).toHaveLength(101)
    expect(ownerName).toBe('Jane')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('/review/list_rss/12345?shelf=read&page=1')
    expect(fetchMock.mock.calls[1][0]).toContain('page=2')
  })

  it('throws when the first page fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    await expect(fetchShelfBooks('12345', 'read')).rejects.toThrow('404')
  })

  it('stops at the cap', async () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      rssItem({ title: `Book ${i}`, author_name: 'A', isbn: '', book_id: String(i) })
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => rssPage(items) }))
    const { books } = await fetchShelfBooks('12345', 'read', 150)
    expect(books).toHaveLength(150)
  })
})
