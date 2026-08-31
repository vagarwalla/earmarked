import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  blockedAddressReason,
  isBlockedAddress,
  assertPublicUrl,
  safeFetch,
  SafeFetchError,
  __setDnsLookup,
  PRESS_USER_AGENT,
} from '../fetch'
import {
  extractFromUrl,
  extractFromNewsletterHtml,
  extractWithDefuddle,
  extractWithReadability,
  stripExternalReferences,
  hasExternalReferences,
  parseHtml,
  articleLength,
  attachImages,
  ExtractionError,
  MIN_ARTICLE_CHARS,
} from '../extract'
import {
  looksLikeTrackingPixel,
  orientationOf,
  fetchAndStoreImage,
  fetchAndStoreImages,
  MIN_IMAGE_EDGE,
} from '../images'
import type { ArticleBlock } from '../types'
import type { StoredImage } from '../images'

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

// Tests must never touch real DNS or the network.
beforeEach(() => {
  __setDnsLookup(async (host) => {
    if (host === 'private.example.com') return ['10.0.0.5']
    if (host === 'metadata.example.com') return ['169.254.169.254']
    if (host === 'nowhere.example.com') return []
    return ['93.184.216.34']
  })
})
afterEach(() => {
  __setDnsLookup(null)
  vi.unstubAllGlobals()
})

// ── The SSRF guard ───────────────────────────────────────────────────────────

describe('blockedAddressReason', () => {
  it('refuses every private and special-purpose IPv4 range', () => {
    const blocked = [
      '127.0.0.1',
      '127.9.9.9',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254', // the one that matters: cloud metadata
      '0.0.0.0',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '192.0.2.1',
    ]
    for (const addr of blocked) {
      expect(blockedAddressReason(addr), addr).not.toBeNull()
    }
  })

  it('lets ordinary public addresses through', () => {
    for (const addr of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '2606:2800:220:1::']) {
      expect(blockedAddressReason(addr), addr).toBeNull()
    }
  })

  it('refuses private IPv6', () => {
    for (const addr of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1']) {
      expect(blockedAddressReason(addr), addr).not.toBeNull()
    }
  })

  it('sees through IPv4-mapped and translated IPv6', () => {
    // The classic bypass: a v6 spelling of a v4 loopback.
    expect(blockedAddressReason('::ffff:127.0.0.1')).not.toBeNull()
    expect(blockedAddressReason('::ffff:169.254.169.254')).not.toBeNull()
    expect(blockedAddressReason('64:ff9b::169.254.169.254')).not.toBeNull()
    // ...while the same wrapper around a public address is fine.
    expect(blockedAddressReason('::ffff:93.184.216.34')).toBeNull()
  })

  it('fails closed on anything it cannot parse', () => {
    for (const junk of ['', 'not-an-address', '999.1.1.1', '1.2.3', '12345']) {
      expect(isBlockedAddress(junk), junk).toBe(true)
    }
  })
})

describe('assertPublicUrl', () => {
  it('refuses non-http schemes', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'data:text/html,hi']) {
      await expect(assertPublicUrl(url)).rejects.toThrow(SafeFetchError)
    }
  })

  it('refuses a hostname that resolves into private space', async () => {
    await expect(assertPublicUrl('https://private.example.com/a')).rejects.toThrow(/10\.0\.0\.5/)
    await expect(assertPublicUrl('http://metadata.example.com/latest/meta-data/')).rejects.toThrow(
      /link-local/,
    )
  })

  it('refuses a literal private address without consulting DNS', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /link-local/,
    )
    await expect(assertPublicUrl('http://[::1]:8080/')).rejects.toThrow(/loopback/)
  })

  it('refuses internal-only name suffixes whatever the resolver says', async () => {
    await expect(assertPublicUrl('http://printer.local/')).rejects.toThrow(/internal hostname/)
    await expect(assertPublicUrl('http://db.internal/')).rejects.toThrow(/internal hostname/)
  })

  it('refuses a host that resolves to nothing', async () => {
    await expect(assertPublicUrl('https://nowhere.example.com/')).rejects.toThrow(/resolved to nothing/)
  })

  it('allows an ordinary public URL', async () => {
    await expect(assertPublicUrl('https://example.com/a')).resolves.toBeInstanceOf(URL)
  })
})

describe('safeFetch redirects', () => {
  it('refuses a public host that redirects into private space', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } }),
      ),
    )
    await expect(safeFetch('https://example.com/start')).rejects.toThrow(/link-local/)
  })

  it('caps the redirect chain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }),
      ),
    )
    await expect(safeFetch('https://example.com/a', { maxRedirects: 2 })).rejects.toThrow(
      /more than 2 redirects/,
    )
  })

  it('drops credentials when a redirect crosses origins', async () => {
    const seen: Headers[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: RequestInit) => {
        seen.push(new Headers(init.headers))
        return seen.length === 1
          ? new Response(null, { status: 302, headers: { location: 'https://other.example.com/b' } })
          : new Response('ok', { status: 200 })
      }),
    )
    await safeFetch('https://example.com/a', { headers: { authorization: 'Bearer secret' } })
    expect(seen[0].get('authorization')).toBe('Bearer secret')
    expect(seen[1].get('authorization')).toBeNull()
  })

  it('identifies itself and reports the final hop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: RequestInit) => {
        expect(new Headers(init.headers).get('user-agent')).toBe(PRESS_USER_AGENT)
        return new Response('body', { status: 200 })
      }),
    )
    const res = await safeFetch('https://example.com/a')
    expect(res.url).toBe('https://example.com/a')
    expect(await res.text()).toBe('body')
  })

  it('refuses a body that overruns the cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(5000), { status: 200 })))
    await expect(safeFetch('https://example.com/a', { maxBytes: 1000 })).rejects.toThrow(/exceeded/)
  })
})

// ── External-reference stripping ─────────────────────────────────────────────

describe('stripExternalReferences', () => {
  it('removes every element that can fetch', () => {
    const dom = parseHtml(
      `<body><p>keep</p><script src="https://x/a.js"></script><style>@import url(https://x/a.css)</style>
       <link rel="stylesheet" href="https://x/a.css"><iframe src="https://x/"></iframe>
       <video src="https://x/v.mp4"></video><svg><use href="https://x/s.svg"/></svg></body>`,
    )
    stripExternalReferences(dom.window.document.body)
    const html = dom.window.document.body.innerHTML
    expect(html).toContain('keep')
    expect(hasExternalReferences(html)).toBe(false)
  })

  it('strips attributes that are not on the allowlist', () => {
    const dom = parseHtml(
      `<body><p style="background:url(https://x/a.png)" onclick="steal()" data-src="https://x/b">t</p>
       <img src="https://cdn.example.com/a.jpg" alt="a" srcset="https://cdn.example.com/a-2x.jpg 2x" loading="lazy"></body>`,
    )
    stripExternalReferences(dom.window.document.body)
    const html = dom.window.document.body.innerHTML
    expect(html).not.toContain('style=')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('srcset')
    expect(html).not.toContain('data-src')
    // src and alt survive — images are resolved to local paths downstream.
    expect(html).toContain('src="https://cdn.example.com/a.jpg"')
    expect(html).toContain('alt="a"')
  })

  it('strips javascript: and data: URLs from kept attributes', () => {
    const dom = parseHtml(
      `<body><a href="javascript:alert(1)">x</a><img src="data:image/gif;base64,R0lGOD"></body>`,
    )
    stripExternalReferences(dom.window.document.body)
    const html = dom.window.document.body.innerHTML
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data:image')
  })
})

describe('hasExternalReferences', () => {
  it('recognises the shapes that would make the renderer hit the network', () => {
    expect(hasExternalReferences('<img src="https://x/a.png">')).toBe(true)
    expect(hasExternalReferences('<img src="//x/a.png">')).toBe(true)
    expect(hasExternalReferences('<style>@import "https://x/a.css"</style>')).toBe(true)
    expect(hasExternalReferences('<style>@font-face{src:url(https://x/f.woff)}</style>')).toBe(true)
    expect(hasExternalReferences('<div style="background:url(//x/a.png)">')).toBe(true)
  })

  it('does not flag a local document', () => {
    expect(hasExternalReferences('<img src="items/abc/images/00.jpg"><p>https in text is fine</p>')).toBe(
      false,
    )
  })
})

// ── Extraction ───────────────────────────────────────────────────────────────

const noImages = async () => []

describe('extractWithDefuddle / extractWithReadability', () => {
  it('pulls the article out of the page furniture', () => {
    const result = extractWithDefuddle(fixture('article.html'), 'https://quarry.example.com/salt-roads')
    expect(result).not.toBeNull()
    expect(result!.title).toMatch(/Salt Roads/)
    const text = JSON.stringify(result!.blocks)
    expect(text).toMatch(/infrastructure/)
    // Boilerplate is gone.
    expect(text).not.toMatch(/cookie/i)
    expect(text).not.toMatch(/Subscribe/)
    expect(text).not.toMatch(/All rights reserved/)
  })

  it('readability reaches the same article independently', () => {
    const result = extractWithReadability(fixture('article.html'), 'https://quarry.example.com/salt-roads')
    expect(result).not.toBeNull()
    expect(articleLength(result!.blocks)).toBeGreaterThan(MIN_ARTICLE_CHARS)
  })

  it('returns null on a page with no article in it', () => {
    const url = 'https://walled.example.com/p'
    expect(extractWithDefuddle(fixture('js-walled.html'), url)).toBeNull()
    expect(extractWithReadability(fixture('js-walled.html'), url)).toBeNull()
  })
})

describe('extractFromUrl', () => {
  const deps = (html: string) => ({
    fetchText: async () => ({ text: html, url: 'https://quarry.example.com/salt-roads', status: 200 }),
    storeImages: noImages as never,
  })

  it('produces a normalized article with no external references left', async () => {
    const { article, rung } = await extractFromUrl({
      itemId: 'item1',
      url: 'https://quarry.example.com/salt-roads',
      deps: deps(fixture('article.html')),
    })
    expect(rung).toBe('defuddle')
    expect(article.title).toMatch(/Salt Roads/)
    expect(article.blocks.length).toBeGreaterThan(3)

    // The hard guarantee U4 depends on.
    const serialized = JSON.stringify(article)
    expect(hasExternalReferences(serialized)).toBe(false)
    expect(serialized).not.toMatch(/cdn\.example\.com/)
    expect(serialized).not.toMatch(/tracker\.example\.com/)
  })

  it('keeps captions and drops figures whose image did not survive', async () => {
    const stored: StoredImage[] = [
      {
        path: 'items/item1/images/00.jpg',
        alt: 'Salt pans at dusk',
        caption: 'Evaporation pans outside Salins-les-Bains, still worked in the 1890s.',
        width: 1600,
        height: 900,
        orientation: 'landscape',
        sourceUrl: 'https://cdn.example.com/img/salt-pans-wide.jpg',
      },
    ]
    const { article } = await extractFromUrl({
      itemId: 'item1',
      url: 'https://quarry.example.com/salt-roads',
      deps: {
        ...deps(fixture('article.html')),
        storeImages: (async () => stored) as never,
      },
    })
    // The one landscape image became the opener's lead.
    expect(article.lead?.path).toBe('items/item1/images/00.jpg')
    expect(article.lead?.caption).toMatch(/Salins-les-Bains/)
    // The portrait ledger and the tracking pixel did not survive, so no figures remain.
    expect(article.blocks.filter((b) => b.type === 'figure')).toHaveLength(0)
  })

  it('falls through the ladder and reports what it tried', async () => {
    await expect(
      extractFromUrl({
        itemId: 'item2',
        url: 'https://walled.example.com/p',
        deps: {
          fetchText: async () => ({ text: fixture('js-walled.html'), url: 'https://walled.example.com/p', status: 200 }),
          storeImages: noImages as never,
        },
      }),
    ).rejects.toThrow(ExtractionError)

    const err = await extractFromUrl({
      itemId: 'item2',
      url: 'https://walled.example.com/p',
      deps: {
        fetchText: async () => ({ text: fixture('js-walled.html'), url: 'https://walled.example.com/p', status: 200 }),
        storeImages: noImages as never,
      },
    }).catch((e: ExtractionError) => e)
    expect((err as ExtractionError).attempted).toEqual(['defuddle', 'readability'])
  })

  it('reaches for the Raindrop permanent copy when the live page is walled', async () => {
    const { article, rung } = await extractFromUrl({
      itemId: 'item3',
      url: 'https://walled.example.com/p',
      raindropId: '99',
      deps: {
        fetchText: async () => ({ text: fixture('js-walled.html'), url: 'https://walled.example.com/p', status: 200 }),
        storeImages: noImages as never,
        fetchRaindropCache: async (id) => (id === '99' ? fixture('article.html') : null),
      },
    })
    expect(rung).toBe('raindrop-cache')
    expect(article.title).toMatch(/Salt Roads/)
  })

  it('refuses a soft-404 rather than printing a publication homepage', async () => {
    // Substack answers a missing post with its publication homepage under a
    // 404. That page extracts cleanly, so only the status distinguishes it
    // from a real article — and without the check it becomes printed pages.
    const err = await extractFromUrl({
      itemId: 'item404',
      url: 'https://quarry.example.com/p/deleted-post',
      deps: {
        fetchText: async () => ({
          text: fixture('article.html'), // plausible, extractable, and not the saved piece
          url: 'https://quarry.example.com/p/deleted-post',
          status: 404,
        }),
        storeImages: noImages as never,
      },
    }).catch((e: ExtractionError) => e)

    expect(err).toBeInstanceOf(ExtractionError)
    expect((err as ExtractionError).message).toMatch(/HTTP 404/)
  })

  it('refuses a 5xx page for the same reason', async () => {
    await expect(
      extractFromUrl({
        itemId: 'item500',
        url: 'https://quarry.example.com/p/x',
        deps: {
          fetchText: async () => ({ text: fixture('article.html'), url: 'x', status: 503 }),
          storeImages: noImages as never,
        },
      }),
    ).rejects.toThrow(/HTTP 503/)
  })

  it('falls back to the Raindrop copy when the live page has since 404ed', async () => {
    // The common case for a saved link: it worked when it was saved.
    const { rung, article } = await extractFromUrl({
      itemId: 'item404b',
      url: 'https://quarry.example.com/p/deleted-post',
      raindropId: '99',
      deps: {
        fetchText: async () => ({ text: '<html><body>gone</body></html>', url: 'x', status: 404 }),
        storeImages: noImages as never,
        fetchRaindropCache: async () => fixture('article.html'),
      },
    })
    expect(rung).toBe('raindrop-cache')
    expect(article.title).toMatch(/Salt Roads/)
  })

  it('still tries the cache when the page could not be fetched at all', async () => {
    const { rung } = await extractFromUrl({
      itemId: 'item4',
      url: 'https://dead.example.com/p',
      raindropId: '99',
      deps: {
        fetchText: async () => {
          throw new SafeFetchError('dns', 'could not resolve dead.example.com')
        },
        storeImages: noImages as never,
        fetchRaindropCache: async () => fixture('article.html'),
      },
    })
    expect(rung).toBe('raindrop-cache')
  })
})

describe('extractFromNewsletterHtml', () => {
  it('keeps the full text and strips the subscription furniture', async () => {
    const { article, rung } = await extractFromNewsletterHtml({
      itemId: 'nl1',
      html: fixture('newsletter.html'),
      senderName: 'Cold Comfort',
      deps: { storeImages: noImages as never },
    })
    expect(rung).toBe('newsletter')
    expect(article.title).toMatch(/Longest Winter/)
    expect(article.sourceName).toBe('Cold Comfort')

    const text = JSON.stringify(article)
    expect(text).toMatch(/Little Ice Age|frost|Thames/i)
    expect(text).not.toMatch(/Unsubscribe/i)
    expect(text).not.toMatch(/Update your profile/i)
    expect(text).not.toMatch(/view this post in your browser/i)
    expect(text).not.toMatch(/You're receiving this|You’re receiving this/i)
    expect(hasExternalReferences(text)).toBe(false)
  })

  it('does not print the headline twice', async () => {
    const { article } = await extractFromNewsletterHtml({
      itemId: 'nl2',
      html: fixture('newsletter.html'),
      deps: { storeImages: noImages as never },
    })
    const repeated = article.blocks.filter(
      (b) => b.type === 'heading' && b.text.trim() === article.title.trim(),
    )
    expect(repeated).toHaveLength(0)
  })

  it('refuses a newsletter with no article in it', async () => {
    await expect(
      extractFromNewsletterHtml({
        itemId: 'nl3',
        html: '<body><p>Thanks for subscribing!</p></body>',
        deps: { storeImages: noImages as never },
      }),
    ).rejects.toThrow(/too short/)
  })
})

// ── Images ───────────────────────────────────────────────────────────────────

describe('looksLikeTrackingPixel', () => {
  it('recognises the usual suspects', () => {
    for (const url of [
      'https://x.example.com/pixel.gif',
      'https://x.example.com/track?id=1',
      'https://x.example.com/open.gif?u=2',
      'https://x.example.com/spacer.gif',
      'https://cdn.example.com/a/1x1.png',
      'https://cdn.example.com/img/logo-16x16.png',
      'https://cdn.example.com/i.jpg?width=1',
    ]) {
      expect(looksLikeTrackingPixel(url), url).toBe(true)
    }
  })

  it('leaves real photographs alone', () => {
    for (const url of [
      'https://cdn.example.com/img/salt-pans-wide.jpg',
      'https://cdn.example.com/photo-1600x900.jpg',
      'https://cdn.example.com/i.jpg?width=1456',
    ]) {
      expect(looksLikeTrackingPixel(url), url).toBe(false)
    }
  })
})

describe('orientationOf', () => {
  it('classifies the three shapes the layout cares about', () => {
    expect(orientationOf(1600, 900)).toBe('landscape')
    expect(orientationOf(900, 1600)).toBe('portrait')
    expect(orientationOf(1000, 1000)).toBe('square')
  })
})

describe('fetchAndStoreImage', () => {
  const png = (w: number, h: number) => {
    // A real, decodable PNG so sharp reads genuine dimensions.
    return import('sharp').then((m) =>
      m
        .default({ create: { width: w, height: h, channels: 3, background: { r: 20, g: 30, b: 40 } } })
        .png()
        .toBuffer(),
    )
  }

  it('stores a real photograph and measures it', async () => {
    const bytes = new Uint8Array(await png(1600, 900))
    const store = vi.fn(async (p: string) => p)
    const image = await fetchAndStoreImage(
      'item1',
      { url: 'https://cdn.example.com/a.png', alt: 'a', caption: 'c' },
      0,
      {
        fetchBytes: (async () => ({ bytes, url: 'https://cdn.example.com/a.png', status: 200, contentType: 'image/png' })) as never,
        store: store as never,
      },
    )
    expect(image).not.toBeNull()
    expect(image!.path).toBe('items/item1/images/00.png')
    expect(image!.width).toBe(1600)
    expect(image!.orientation).toBe('landscape')
    expect(store).toHaveBeenCalledOnce()
  })

  it('drops an image too small to be content', async () => {
    const bytes = new Uint8Array(await png(MIN_IMAGE_EDGE - 100, MIN_IMAGE_EDGE - 100))
    const image = await fetchAndStoreImage('item1', { url: 'https://cdn.example.com/s.png', alt: null, caption: null }, 0, {
      fetchBytes: (async () => ({ bytes, url: 'x', status: 200, contentType: 'image/png' })) as never,
      store: (async (p: string) => p) as never,
    })
    expect(image).toBeNull()
  })

  it('drops an image the fetch guard refuses instead of failing the article', async () => {
    const image = await fetchAndStoreImage('item1', { url: 'http://10.0.0.5/a.png', alt: null, caption: null }, 0, {
      fetchBytes: (async () => {
        throw new SafeFetchError('blocked-address', 'refusing 10.0.0.5 (private)')
      }) as never,
      store: (async (p: string) => p) as never,
    })
    expect(image).toBeNull()
  })

  it('numbers only the images that survived, leaving no gaps', async () => {
    const good = new Uint8Array(await png(1200, 800))
    const tiny = new Uint8Array(await png(40, 40))
    const bodies = [good, tiny, good]
    let i = 0
    const stored = await fetchAndStoreImages(
      'item1',
      [
        { url: 'https://cdn.example.com/1.png', alt: null, caption: null },
        { url: 'https://cdn.example.com/2.png', alt: null, caption: null },
        { url: 'https://cdn.example.com/3.png', alt: null, caption: null },
      ],
      {
        fetchBytes: (async () => ({ bytes: bodies[i++], url: 'x', status: 200, contentType: 'image/png' })) as never,
        store: (async (p: string) => p) as never,
      },
    )
    expect(stored.map((s) => s.path)).toEqual([
      'items/item1/images/00.png',
      'items/item1/images/01.png',
    ])
  })
})

describe('attachImages', () => {
  it('drops figures whose image did not survive the download', () => {
    const blocks: ArticleBlock[] = [
      { type: 'para', html: 'a' },
      { type: 'figure', image: { path: '#candidate-0', alt: null, caption: null, width: null, height: null, orientation: 'landscape' } },
      { type: 'figure', image: { path: '#candidate-1', alt: null, caption: null, width: null, height: null, orientation: 'landscape' } },
    ]
    const stored: (StoredImage | null)[] = [
      { path: 'items/i/images/00.jpg', alt: null, caption: null, width: 10, height: 10, orientation: 'square', sourceUrl: 'x' },
      null,
    ]
    const out = attachImages(blocks, stored)
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ type: 'figure', image: { path: 'items/i/images/00.jpg' } })
  })
})
