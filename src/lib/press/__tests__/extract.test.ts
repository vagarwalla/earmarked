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
  stripCommentSections,
  hasExternalReferences,
  parseHtml,
  extractFootnotes,
  toBlocks,
  articleLength,
  attachImages,
  ExtractionError,
  MIN_ARTICLE_CHARS,
} from '../extract'
import {
  looksLikeTrackingPixel,
  largerImageUrls,
  imageIdentity,
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

describe('comment threads', () => {
  it('does not print the replies under a forum post', async () => {
    // A real EA Forum post came through as 24 printed pages, 19 of them
    // other people's comments. Nobody saved the link for the comments.
    const body = '<p>Article body long enough to clear the minimum length check. </p>'.repeat(12)
    const html = `<article><h1>A post</h1>${body}
      <section id="comments"><div class="comment"><p>${'A reader replies at length. '.repeat(80)}</p></div></section>
      <div class="CommentsListSection"><p>${'And another reply. '.repeat(80)}</p></div>
    </article>`

    const { article } = await extractFromUrl({
      itemId: 'c1',
      url: 'https://forum.example.com/posts/x',
      deps: {
        fetchText: async () => ({ text: html, url: 'https://forum.example.com/posts/x', status: 200 }),
        storeImages: noImages as never,
      },
    })

    const text = JSON.stringify(article)
    expect(text).toMatch(/Article body/)
    expect(text).not.toMatch(/A reader replies/)
    expect(text).not.toMatch(/And another reply/)
  })

  it('strips the comment container before either extractor sees it', () => {
    const dom = parseHtml(
      '<body><article><p>body</p></article><div class="comment-body"><p>a reply</p></div></body>',
    )
    stripCommentSections(dom.window.document)
    expect(dom.window.document.body.textContent).toContain('body')
    expect(dom.window.document.body.textContent).not.toContain('a reply')
  })

  /**
   * The shapes real sites wrap a thread in. Each of these has put comments
   * into a printed issue, or would have: the EA Forum and LessWrong hyphenate
   * and camel-case, Substack has its own, WordPress numbers its ids, and the
   * embedded widgets (Disqus, giscus, utterances) name themselves.
   *
   * One test per shape rather than one big page, so a regression names the
   * markup it stopped catching.
   */
  const THREADS: [name: string, markup: string][] = [
    ['a bare #comments section', '<section id="comments">REPLY</section>'],
    ['LessWrong\u2019s CommentsListSection', '<div class="CommentsListSection">REPLY</div>'],
    ['the EA Forum\u2019s comment-body', '<div class="comment-body">REPLY</div>'],
    ['a striped reply row', '<div class="bg-comment-even">REPLY</div>'],
    ['an underscored class', '<div class="comment_wrap">REPLY</div>'],
    // The three the separator-anchored rules used to miss entirely.
    ['WordPress\u2019s comments-area', '<div class="comments-area">REPLY</div>'],
    ['a comments-section', '<div class="comments-section">REPLY</div>'],
    ['an underscored plural', '<div class="comments_wrapper">REPLY</div>'],
    ['a WordPress comment id', '<li id="comment-4821">REPLY</li>'],
    ['Disqus', '<div id="disqus_thread">REPLY</div>'],
    ['giscus', '<div class="giscus">REPLY</div>'],
    ['utterances', '<div class="utterances">REPLY</div>'],
    ['a testid a framework left behind', '<div data-testid="CommentThread">REPLY</div>'],
    ['a labelled region', '<section aria-label="Comments">REPLY</section>'],
  ]

  const reply = 'A reader replies at length and at length again. '.repeat(60)
  const body = '<p>Article body long enough to clear the minimum length check. </p>'.repeat(12)

  for (const [name, markup] of THREADS) {
    it(`does not print ${name}`, async () => {
      const html = `<article><h1>A post</h1>${body}${markup.replace('REPLY', `<p>${reply}</p>`)}</article>`
      const { article } = await extractFromUrl({
        itemId: 'c-thread',
        url: 'https://forum.example.com/posts/x',
        deps: {
          fetchText: async () => ({ text: html, url: 'https://forum.example.com/posts/x', status: 200 }),
          storeImages: noImages as never,
        },
      })
      const text = JSON.stringify(article)
      expect(text).toMatch(/Article body/)
      expect(text).not.toMatch(/A reader replies/)
    })
  }

  it('does not let a thread in through the newsletter door either', async () => {
    // Newsletters skip the extraction ladder entirely, so they do not go past
    // `stripCommentSections`. `stripExternalReferences` carries the same
    // selectors for exactly this reason, and that is what this holds down.
    const html = `<body><h1>A newsletter</h1>${body}
      <div class="comments-area"><p>${reply}</p></div></body>`
    const { article } = await extractFromNewsletterHtml({
      itemId: 'c-nl',
      html,
      deps: { storeImages: noImages as never },
    })
    const text = JSON.stringify(article)
    expect(text).toMatch(/Article body/)
    expect(text).not.toMatch(/A reader replies/)
  })

  it('does not turn a thread into footnotes on the way out', async () => {
    // The apparatus scan looks for a "Notes" heading followed by an ordered
    // list, which is exactly the shape a thread with a "Notes" aside has. If
    // the comments survived long enough to be scanned they would print as the
    // article's own notes, which is a worse failure than printing them as
    // prose: they would carry numbers and look authored.
    const html = `<article><h1>A post</h1>${body}
      <section id="comments">
        <h2>Notes</h2>
        <ol><li>${reply}</li></ol>
      </section></article>`
    const { article } = await extractFromUrl({
      itemId: 'c-notes',
      url: 'https://forum.example.com/posts/x',
      deps: {
        fetchText: async () => ({ text: html, url: 'https://forum.example.com/posts/x', status: 200 }),
        storeImages: noImages as never,
      },
    })
    expect(article.footnotes ?? []).toEqual([])
    expect(JSON.stringify(article)).not.toMatch(/A reader replies/)
  })

  it('strips a thread whether it is handed a document or one element', () => {
    // `extractFromUrl` passes the whole document and the newsletter path
    // passes `<body>`; both have to lose the thread.
    for (const asDocument of [true, false]) {
      const dom = parseHtml('<body><article><p>body</p></article><div class="comment-body"><p>a reply</p></div></body>')
      const root = asDocument ? dom.window.document : dom.window.document.body
      stripExternalReferences(root)
      expect(dom.window.document.body.textContent).toContain('body')
      expect(dom.window.document.body.textContent).not.toContain('a reply')
    }
  })

  it('does not mistake commentary for comments', () => {
    // The selectors match on the separator precisely so that words which
    // merely begin with "comment" are left alone.
    const dom = parseHtml(
      '<body><div class="commentary"><p>a reading of the text</p></div>' +
        '<p class="commented">an annotated line</p></body>',
    )
    stripCommentSections(dom.window.document)
    expect(dom.window.document.body.textContent).toContain('a reading of the text')
    expect(dom.window.document.body.textContent).toContain('an annotated line')
  })
})

describe('block-level unwrapping', () => {
  it('does not fuse the words either side of an unwrapped block', async () => {
    // Seen in a real issue: "…breath of God.Saint Hildegard of Bingen".
    const html = `<article><h1>T</h1>${'<p>Body text that is long enough to clear the minimum. </p>'.repeat(12)}
      <blockquote><p>I am a feather on the breath of God.</p><cite>Saint Hildegard of Bingen</cite></blockquote></article>`
    const { article } = await extractFromUrl({
      itemId: 'q1',
      url: 'https://example.com/q',
      deps: {
        fetchText: async () => ({ text: html, url: 'https://example.com/q', status: 200 }),
        storeImages: noImages as never,
      },
    })
    const quote = article.blocks.find((b) => b.type === 'quote')
    expect(quote).toBeDefined()
    expect(JSON.stringify(article)).not.toMatch(/God\.Saint/)
  })

  it('lifts a quotation’s source into its own attribution line', async () => {
    const html = `<article><h1>T</h1>${'<p>Body text that is long enough to clear the minimum. </p>'.repeat(12)}
      <blockquote><p>I am a feather on the breath of God.</p><cite>Saint Hildegard of Bingen</cite></blockquote></article>`
    const { article } = await extractFromUrl({
      itemId: 'q2',
      url: 'https://example.com/q',
      deps: {
        fetchText: async () => ({ text: html, url: 'https://example.com/q', status: 200 }),
        storeImages: noImages as never,
      },
    })
    const quote = article.blocks.find((b) => b.type === 'quote') as Extract<
      (typeof article.blocks)[number],
      { type: 'quote' }
    >
    expect(quote.attribution).toBe('Saint Hildegard of Bingen')
    expect(quote.html).not.toMatch(/Hildegard/)
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
        // Fetched from a larger copy than the page showed, which is the
        // ordinary case now — so the two URLs differ and only `candidateUrl`
        // can line this back up with the figure that asked for it.
        sourceUrl: 'https://cdn.example.com/img/salt-pans-wide-2400.jpg',
        candidateUrl: 'https://cdn.example.com/img/salt-pans-wide.jpg',
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

describe('largerImageUrls', () => {
  it('asks Substack for the size it actually has', () => {
    const url =
      'https://substackcdn.com/image/fetch/$s_!m35K!,w_424,c_limit,f_webp,q_auto:good/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fabc_1024x1024.png'
    const bigger = largerImageUrls(url)
    expect(bigger[0]).toContain('w_2100')
    expect(bigger[0]).not.toContain('w_424')
    // And the uploaded original, decoded out of the last path segment.
    expect(bigger).toContain(
      'https://substack-post-media.s3.amazonaws.com/public/images/abc_1024x1024.png',
    )
  })

  it('drops a WordPress crop, in the query and in the filename', () => {
    expect(largerImageUrls('https://blog.test/wp-content/uploads/x.jpg?w=640')).toContain(
      'https://blog.test/wp-content/uploads/x.jpg',
    )
    expect(largerImageUrls('https://i0.wp.com/blog.test/x.png?w=723&ssl=1')).toContain(
      'https://i0.wp.com/blog.test/x.png',
    )
    expect(largerImageUrls('https://blog.test/uploads/photo-1024x539.jpg')).toContain(
      'https://blog.test/uploads/photo.jpg',
    )
  })

  it('offers nothing it cannot justify, and never the URL it was given', () => {
    const url = 'https://undark.org/wp-content/uploads/2017/10/adminvac.jpg'
    expect(largerImageUrls(url)).toEqual([])
    for (const guess of largerImageUrls('https://blog.test/x.jpg?w=1')) {
      expect(guess).not.toBe('https://blog.test/x.jpg?w=1')
    }
  })
})

describe('imageIdentity', () => {
  it('sees one photograph behind two sizes of the same Substack URL', () => {
    const at = (w: number, fmt: string) =>
      `https://substackcdn.com/image/fetch/$s_!U0Lm!,w_${w},c_limit,f_${fmt},q_auto:good/` +
      'https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fx_1024x768.png'
    // What the newsletter sends, and what the live post serves.
    expect(imageIdentity(at(424, 'webp'))).toBe(imageIdentity(at(1456, 'auto')))
    expect(imageIdentity(at(424, 'webp'))).toBe(
      'https://substack-post-media.s3.amazonaws.com/public/images/x_1024x768.png',
    )
  })

  it('sees through a WordPress crop, in the query and in the filename', () => {
    expect(imageIdentity('https://blog.test/x.jpg?w=640')).toBe(imageIdentity('https://blog.test/x.jpg'))
    expect(imageIdentity('https://blog.test/x-1024x539.jpg')).toBe(imageIdentity('https://blog.test/x.jpg'))
  })

  it('keeps two genuinely different pictures apart', () => {
    expect(imageIdentity('https://blog.test/a.jpg?w=640')).not.toBe(
      imageIdentity('https://blog.test/b.jpg?w=640'),
    )
  })
})

describe('largerVersionsOf (through toBlocks)', () => {
  const candidates = (html: string) =>
    toBlocks(parseHtml(`<body><div id="r">${html}</div></body>`).window.document.getElementById('r')!)
      .images

  it('takes the full plate a thumbnail links to', () => {
    const [c] = candidates(
      '<p><a href="https://static.pinboard.in/si/si.001.jpg">' +
        '<img src="https://static.pinboard.in/si/thumbs/si.001.thumb.jpg"></a></p>',
    )
    expect(c.alternates).toEqual(['https://static.pinboard.in/si/si.001.jpg'])
  })

  it('takes the widest srcset entry first, and ignores a link to a page', () => {
    const [c] = candidates(
      '<p><a href="https://blog.test/post"><img src="https://cdn.test/s.jpg" ' +
        'srcset="https://cdn.test/m.jpg 800w, https://cdn.test/l.jpg 2000w"></a></p>',
    )
    expect(c.alternates).toEqual(['https://cdn.test/l.jpg', 'https://cdn.test/m.jpg'])
  })

  it('takes a lazy-loader original out of a data attribute', () => {
    const [c] = candidates(
      '<p><img src="https://cdn.test/tiny.jpg" data-large-file="https://cdn.test/full.jpg"></p>',
    )
    expect(c.alternates).toContain('https://cdn.test/full.jpg')
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

  it('takes the biggest version offered, and falls back when a guess 404s', async () => {
    const big = new Uint8Array(await png(1920, 1200))
    const small = new Uint8Array(await png(350, 218))
    const asked: string[] = []
    const image = await fetchAndStoreImage(
      'item1',
      {
        url: 'https://static.pinboard.in/si/thumbs/si.001.thumb.jpg',
        alt: null,
        caption: null,
        alternates: ['https://static.pinboard.in/si/gone.jpg', 'https://static.pinboard.in/si/si.001.jpg'],
      },
      0,
      {
        fetchBytes: (async (url: string) => {
          asked.push(url)
          if (url.endsWith('gone.jpg')) throw new Error('fetch returned HTTP 404')
          const bytes = url.endsWith('si.001.jpg') ? big : small
          return { bytes, url, status: 200, contentType: 'image/png' }
        }) as never,
        store: (async (p: string) => p) as never,
      },
    )

    expect(asked[0]).toContain('gone.jpg')
    expect(image!.width).toBe(1920)
    expect(image!.sourceUrl).toBe('https://static.pinboard.in/si/si.001.jpg')
    // It stopped as soon as it had one: the thumbnail was never downloaded.
    expect(asked).not.toContain('https://static.pinboard.in/si/thumbs/si.001.thumb.jpg')
  })

  it('keeps an upgraded plate attached to the figure that asked for it', async () => {
    // The regression this guards: `finish()` re-aligns stored images onto
    // candidates, and once images.ts started fetching a *larger* copy the two
    // URLs stopped matching — which dropped every upgraded plate silently.
    const big = new Uint8Array(await png(1920, 1200))
    const stored = await fetchAndStoreImages(
      'item1',
      [
        {
          url: 'https://cdn.test/thumbs/a.thumb.jpg',
          alt: null,
          caption: null,
          alternates: ['https://cdn.test/a.jpg'],
        },
      ],
      {
        fetchBytes: (async (url: string) => ({ bytes: big, url, status: 200, contentType: 'image/png' })) as never,
        store: (async (p: string) => p) as never,
      },
    )
    expect(stored[0].sourceUrl).toBe('https://cdn.test/a.jpg')
    expect(stored[0].candidateUrl).toBe('https://cdn.test/thumbs/a.thumb.jpg')

    const blocks = attachImages(
      [{ type: 'figure', image: { path: '#candidate-0', alt: null, caption: null, width: null, height: null, orientation: 'landscape' } }],
      [stored[0]],
    )
    expect(blocks).toHaveLength(1)
  })

  it('falls back to the URL the page displayed when every guess fails', async () => {
    const bytes = new Uint8Array(await png(1600, 1000))
    const image = await fetchAndStoreImage(
      'item1',
      { url: 'https://cdn.test/a.jpg?w=640', alt: null, caption: null },
      0,
      {
        fetchBytes: (async (url: string) => {
          if (!url.includes('?w=640')) throw new Error('fetch returned HTTP 403')
          return { bytes, url, status: 200, contentType: 'image/png' }
        }) as never,
        store: (async (p: string) => p) as never,
      },
    )
    expect(image!.width).toBe(1600)
    expect(image!.sourceUrl).toBe('https://cdn.test/a.jpg?w=640')
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
      { path: 'items/i/images/00.jpg', alt: null, caption: null, width: 10, height: 10, orientation: 'square', sourceUrl: 'x', candidateUrl: 'x' },
      null,
    ]
    const out = attachImages(blocks, stored)
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ type: 'figure', image: { path: 'items/i/images/00.jpg' } })
  })
})

// ── Footnotes ────────────────────────────────────────────────────────────────

describe('extractFootnotes', () => {
  const root = (html: string) =>
    parseHtml(`<body><div id="r">${html}</div></body>`).window.document.getElementById('r')!

  it('lifts a Pandoc/WordPress apparatus and keeps the source numbering', () => {
    const el = root(`
      <p>Living amongst the Nazis.<sup>1</sup></p>
      <p>A casual greeting.<sup>2</sup></p>
      <div class="footnotes">
        <ol>
          <li id="fn1">The first note. <a href="#fnref1">↩</a></li>
          <li id="fn2">The second note. <a href="#fnref2">↩</a></li>
        </ol>
      </div>`)
    const notes = extractFootnotes(el)
    expect(notes).toEqual([
      { marker: '1', html: 'The first note.' },
      { marker: '2', html: 'The second note.' },
    ])
    // And they are gone from the tree, so toBlocks cannot also emit them.
    expect(el.querySelector('.footnotes')).toBeNull()
    expect(toBlocks(el).blocks.filter((b) => b.type === 'para')).toHaveLength(2)
  })

  it('reads a Substack apparatus, where each note is its own div', () => {
    const notes = extractFootnotes(
      root(`
        <p>Body.<sup>1</sup></p>
        <div class="footnote">
          <a class="footnote-number" href="#f1">1</a>
          <div class="footnote-content"><p>Substack note.</p></div>
        </div>`),
    )
    expect(notes).toEqual([{ marker: '1', html: 'Substack note.' }])
  })

  it('reads a bare "Notes" heading followed by an ordered list', () => {
    // The EA Forum marks its apparatus no other way.
    const el = root(`
      <p>Body.<sup>1</sup></p>
      <h2>Notes</h2>
      <ol><li>Thinking of classical utilitarianism.</li><li>And the other one.</li></ol>`)
    const notes = extractFootnotes(el)
    expect(notes.map((n) => n.marker)).toEqual(['1', '2'])
    expect(notes[0].html).toBe('Thinking of classical utilitarianism.')
    // The heading goes too, or the article ends on an empty "Notes".
    expect(el.querySelector('h2')).toBeNull()
    expect(el.querySelector('ol')).toBeNull()
  })

  it('does not mistake an ordinary ordered list for notes', () => {
    const el = root('<p>Body.</p><h2>Recommended reading</h2><ol><li>A book</li></ol>')
    expect(extractFootnotes(el)).toEqual([])
    expect(el.querySelector('ol')).not.toBeNull()
  })

  it('strips the back-link and a repeated leading number', () => {
    const notes = extractFootnotes(
      root('<div class="footnotes"><ol><li id="fn-3">3. The note itself. ↩︎</li></ol></div>'),
    )
    expect(notes).toEqual([{ marker: '3', html: 'The note itself.' }])
  })

  it('keeps emphasis inside a note but drops the link', () => {
    const notes = extractFootnotes(
      root('<div class="footnotes"><ol><li id="fn1">See <em>Don’t Look Up</em>, <a href="https://x.test">here</a>.</li></ol></div>'),
    )
    expect(notes[0].html).toContain('<em>Don’t Look Up</em>')
    expect(notes[0].html).toContain('here')
    expect(notes[0].html).not.toContain('href')
  })

  it('reads a "reference" apparatus, where the note is split from its number', () => {
    // joecarlsmith.com and other bespoke essay themes call these references,
    // never footnotes, and keep the number in its own anchor.
    const el = root(`
      <p>The point.<sup class="article-reference" id="ref-55">55</sup></p>
      <div class="single-essay__references-item reference" id="reference-item-55">
        <a href="#ref-55" class="reference__index reference__index--link">55</a>
        <div class="reference__text"><p>See Soares on how we will be measured.</p></div>
      </div>`)
    const notes = extractFootnotes(el)
    expect(notes).toEqual([{ marker: '55', html: 'See Soares on how we will be measured.' }])
    // The number must not be repeated at the head of the note text.
    expect(notes[0].html.startsWith('55')).toBe(false)
    expect(el.querySelector('.reference__text')).toBeNull()
  })

  it('reads every note when the parse nests one inside another', () => {
    // A grid-laid-out apparatus can parse with later notes nested inside
    // earlier ones. Removing the outer note first disconnects the rest, which
    // silently truncated a 58-note essay to its first 23.
    const el = root(`
      <div class="references-item" id="reference-item-1">
        <a class="reference__index">1</a>
        <div class="reference__text"><p>First note.</p></div>
        <div class="references-item" id="reference-item-2">
          <a class="reference__index">2</a>
          <div class="reference__text"><p>Second note.</p></div>
          <div class="references-item" id="reference-item-3">
            <a class="reference__index">3</a>
            <div class="reference__text"><p>Third note.</p></div>
          </div>
        </div>
      </div>`)
    const notes = extractFootnotes(el)
    expect(notes.map((n) => n.marker)).toEqual(['1', '2', '3'])
    // And an outer note prints only its own text, not everything under it.
    expect(notes[0].html).toBe('First note.')
    expect(notes[1].html).toBe('Second note.')
  })

  it('does not treat an ordinary "references" link list as notes', () => {
    const el = root('<p>Body.</p><div class="reference"><a href="/x">A citation</a></div>')
    expect(extractFootnotes(el)).toEqual([])
  })

  it('removes a second, flattened copy of the same apparatus', () => {
    // The readability pass can leave both the real markup and a "Notes"
    // heading plus list of the same notes. Keeping the marked-up ones is
    // right; leaving the flattened copy in the body printed them twice.
    const el = root(`
      <p>Body.<sup>1</sup></p>
      <div class="footnotes"><ol><li id="fn1">The real note.</li></ol></div>
      <h2>Notes</h2>
      <ol><li>The real note.</li></ol>`)
    const notes = extractFootnotes(el)
    expect(notes).toEqual([{ marker: '1', html: 'The real note.' }])
    expect(el.querySelector('h2')).toBeNull()
    expect(el.querySelector('ol')).toBeNull()
    expect(toBlocks(el).blocks).toHaveLength(1)
  })

  it('returns nothing for an article with no apparatus', () => {
    expect(extractFootnotes(root('<p>Just prose.</p>'))).toEqual([])
  })

  it('drops a note that is empty once the furniture is removed', () => {
    const notes = extractFootnotes(
      root('<div class="footnotes"><ol><li id="fn1"><a href="#a">↩</a></li><li id="fn2">Real.</li></ol></div>'),
    )
    expect(notes).toEqual([{ marker: '2', html: 'Real.' }])
  })
})

// ── Outbound links, for the linkpost classifier ──────────────────────────────

describe('outbound links survive extraction', () => {
  const page = (body: string) => `<!doctype html><html><head><title>Roundup</title></head><body>
    <article>${body}</article></body></html>`

  const roundup = page(
    `<h1>Monthly Roundup</h1>` +
      Array.from(
        { length: 6 },
        (_, i) =>
          `<p>Worth reading: <a href="https://s${i}.test/essay">Essay number ${i} about something</a>, which argues a point at length and is well worth the time it takes.</p>`,
      ).join('') +
      `<p>${'Padding sentence to clear the minimum article length. '.repeat(20)}</p>`,
  )

  it('hands the classifier the hrefs the printed page throws away', () => {
    const rung = extractWithDefuddle(roundup, 'https://zvi.test/p/roundup')
    expect(rung).not.toBeNull()
    expect(rung!.links.length).toBeGreaterThanOrEqual(6)
    expect(rung!.links[0].url).toMatch(/^https:\/\/s0\.test/)
    expect(rung!.links[0].text).toContain('Essay number 0')

    // The blocks themselves still carry no href: print cannot follow one.
    const html = rung!.blocks
      .map((b) => (b.type === 'para' ? b.html : ''))
      .join(' ')
    expect(html).not.toContain('href')
  })

  it('harvests them from a newsletter too', async () => {
    const { links } = await extractFromNewsletterHtml({
      itemId: 'i1',
      html: roundup,
      senderName: 'A Newsletter',
      deps: { storeImages: (async () => []) as never },
    })
    expect(links.length).toBeGreaterThanOrEqual(6)
  })
})
