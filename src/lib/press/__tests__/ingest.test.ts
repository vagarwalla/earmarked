import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  isHomeworkCollection,
  findHomeworkCollection,
  raindropCursor,
  isAfterCursor,
  newRaindropsSince,
  raindropToItem,
  pollRaindrops,
  type Raindrop,
  type RaindropClient,
} from '../raindrop'
import {
  secretMatches,
  isAllowlistedNewsletter,
  extractUrls,
  classifyMail,
  normalizePdfToMediaBox,
  ingestEmail,
  newsletterHtmlPath,
  GMAIL_FORWARDING_SENDER,
} from '../email'
import { MEDIA_WIDTH_PT, MEDIA_HEIGHT_PT, type PressItem } from '../types'
import type { PressSettings } from '../settings'

// ── Fakes ────────────────────────────────────────────────────────────────────

/** Records what press asked the database to do, and hands back plausible rows. */
function fakeDb() {
  const inserted: Record<string, unknown>[] = []
  const updated: { id: string; patch: Record<string, unknown> }[] = []
  const objects = new Map<string, unknown>()
  const cursors = new Map<string, string>()
  let nextId = 1
  /** URLs already in the pipeline — the unique url_key index, in miniature. */
  const seenUrlKeys = new Set<string>()

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      let pendingUpdate: Record<string, unknown> | null = null
      let result: { data: unknown; error: null } = { data: null, error: null }

      builder.select = () => builder
      builder.eq = (col: string, val: string) => {
        if (pendingUpdate) updated.push({ id: val, patch: pendingUpdate })
        void col
        return builder
      }
      builder.in = () => builder
      builder.is = () => builder
      builder.order = () => builder
      builder.limit = () => builder
      builder.maybeSingle = async () => {
        if (table === 'press_cursors') {
          return { data: cursors.size ? { cursor: [...cursors.values()][0] } : null, error: null }
        }
        return result
      }
      builder.insert = (row: Record<string, unknown>) => {
        inserted.push({ table, ...row })
        return builder
      }
      builder.update = (patch: Record<string, unknown>) => {
        pendingUpdate = patch
        return builder
      }
      builder.upsert = (row: Record<string, unknown>, opts?: { ignoreDuplicates?: boolean }) => {
        if (table === 'press_cursors') {
          cursors.set(String(row.source), String(row.cursor))
          result = { data: null, error: null }
          return builder
        }
        const key = row.url_key as string | null
        if (key && seenUrlKeys.has(key) && opts?.ignoreDuplicates) {
          result = { data: [], error: null }
          return builder
        }
        if (key) seenUrlKeys.add(key)
        const full = { id: `item${nextId++}`, created_at: 'now', updated_at: 'now', ...row }
        inserted.push({ table, ...full })
        result = { data: [full], error: null }
        return builder
      }
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return builder
    },
    rpc: async () => ({ data: null, error: null }),
    storage: {
      from: () => ({
        upload: async (path: string, body: unknown) => {
          objects.set(path, body)
          return { error: null }
        },
      }),
    },
  }

  return { client: client as never, inserted, updated, objects, cursors, seenUrlKeys }
}

function settings(over: Partial<PressSettings> = {}): PressSettings {
  return {
    supabaseUrl: 'https://x.supabase.co',
    supabaseServiceKey: 'service',
    storageBucket: 'press',
    raindropToken: 'rd-token',
    raindropCollectionId: '4242',
    emailWebhookSecret: 'shh',
    resendApiKey: 're_key',
    mailFrom: 'press@example.com',
    mailTo: 'owner@example.com',
    newsletterAllowlist: ['letters@coldcomfort.example.com'],
    luluClientKey: '',
    luluClientSecret: '',
    luluSandbox: true,
    luluPackageId: 'pkg',
    anthropicApiKey: null,
    shipping: null,
    pageThreshold: 100,
    maxIssueAgeWeeks: 8,
    appUrl: 'https://app.example.com',
    actionTokenSecret: 'tok',
    ...over,
  }
}

function drop(id: number, created: string, link: string, title = `Item ${id}`): Raindrop {
  return { _id: id, link, title, created, domain: new URL(link).hostname } as Raindrop
}

/** A minimal RaindropClient that records the calls U2 and U9 make. */
function fakeRaindrop(pages: Raindrop[][] = []) {
  const created: { link: string; collectionId: string | number }[] = []
  const client: RaindropClient = {
    listCollections: async () => [],
    resolveHomeworkCollection: async () => null,
    listRaindrops: async (_c, opts) => pages[opts?.page ?? 0] ?? [],
    createRaindrop: async (link, collectionId, title) => {
      created.push({ link, collectionId })
      return drop(9000 + created.length, '2026-08-30T00:00:00Z', link, title ?? '')
    },
    createCollection: async (title) => ({ _id: 1, title }) as never,
    moveRaindrops: async (ids) => ids.length,
  }
  return { client, created }
}

function mime(parts: {
  from?: string
  to?: string
  subject?: string
  html?: string
  text?: string
  pdf?: { filename: string; base64: string }
}): string {
  const from = parts.from ?? 'someone@example.com'
  const headers = [
    `From: ${from}`,
    `To: ${parts.to ?? 'press@example.com'}`,
    `Subject: ${parts.subject ?? 'A subject'}`,
    'Date: Sat, 30 Aug 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
  ]
  if (parts.pdf) {
    const b = 'BOUND1'
    return [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${b}"`,
      '',
      `--${b}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      parts.text ?? 'See attached.',
      '',
      `--${b}`,
      `Content-Type: application/pdf; name="${parts.pdf.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${parts.pdf.filename}"`,
      '',
      parts.pdf.base64.replace(/(.{76})/g, '$1\n'),
      '',
      `--${b}--`,
      '',
    ].join('\r\n')
  }
  if (parts.html) {
    return [...headers, 'Content-Type: text/html; charset=utf-8', '', parts.html, ''].join('\r\n')
  }
  return [...headers, 'Content-Type: text/plain; charset=utf-8', '', parts.text ?? '', ''].join('\r\n')
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ── Raindrop: collection resolution ──────────────────────────────────────────

describe('finding the hw collection', () => {
  it('matches either name the collection may carry, case-insensitively', () => {
    expect(isHomeworkCollection('hw')).toBe(true)
    expect(isHomeworkCollection('Homework')).toBe(true)
    expect(isHomeworkCollection('  HW  ')).toBe(true)
    expect(isHomeworkCollection('homework 2025')).toBe(false)
    expect(isHomeworkCollection('reading')).toBe(false)
  })

  it('picks it out of the collection list', () => {
    const found = findHomeworkCollection([
      { _id: 1, title: 'Recipes' } as never,
      { _id: 7, title: 'homework' } as never,
    ])
    expect(found?._id).toBe(7)
  })
})

// ── Raindrop: the cursor ─────────────────────────────────────────────────────

describe('the poll cursor', () => {
  it('orders by (created, id) so same-second saves are not skipped', () => {
    const a = drop(1, '2026-08-30T10:00:00Z', 'https://e.com/a')
    const b = drop(2, '2026-08-30T10:00:00Z', 'https://e.com/b')
    expect(isAfterCursor(b, raindropCursor(a))).toBe(true)
    expect(isAfterCursor(a, raindropCursor(b))).toBe(false)
    expect(isAfterCursor(a, raindropCursor(a))).toBe(false)
  })

  it('treats everything as new before the first poll', () => {
    expect(isAfterCursor(drop(1, '2020-01-01T00:00:00Z', 'https://e.com/a'), null)).toBe(true)
  })

  it('returns new drops oldest-first', () => {
    const drops = [
      drop(3, '2026-08-30T12:00:00Z', 'https://e.com/c'),
      drop(1, '2026-08-30T10:00:00Z', 'https://e.com/a'),
      drop(2, '2026-08-30T11:00:00Z', 'https://e.com/b'),
    ]
    expect(newRaindropsSince(drops, null).map((d) => d._id)).toEqual([1, 2, 3])
  })
})

describe('raindropToItem', () => {
  it('carries the raindrop id, which U9 needs to archive the item later', () => {
    const item = raindropToItem(drop(55, '2026-08-30T10:00:00Z', 'https://e.com/a', 'A piece'))
    expect(item).toMatchObject({
      source: 'raindrop',
      url: 'https://e.com/a',
      raindrop_id: '55',
      title: 'A piece',
      state: 'queued',
    })
  })
})

describe('pollRaindrops', () => {
  it('ingests new raindrops once and never twice', async () => {
    const db = fakeDb()
    const page = [
      drop(1, '2026-08-30T10:00:00Z', 'https://e.com/a'),
      drop(2, '2026-08-30T11:00:00Z', 'https://e.com/b'),
    ]
    const rd = fakeRaindrop([page])

    const first = await pollRaindrops({ client: rd.client, db: db.client, collectionId: '4242' })
    expect(first.ingested).toHaveLength(2)
    expect(first.cursor).toBe(raindropCursor(page[1]))

    // Second poll over the same collection: the cursor has moved past both.
    const second = await pollRaindrops({ client: rd.client, db: db.client, collectionId: '4242' })
    expect(second.ingested).toHaveLength(0)
    expect(second.scanned).toBe(0)
  })

  it('does not walk the cursor backwards when paging into older drops', async () => {
    const db = fakeDb()
    // Raindrop pages newest-first: page 0 is newer than page 1.
    const newest = Array.from({ length: 50 }, (_, i) =>
      drop(1000 + i, `2026-08-30T12:${String(i).padStart(2, '0')}:00Z`, `https://e.com/n${i}`),
    )
    const older = [drop(1, '2026-01-01T00:00:00Z', 'https://e.com/old')]
    const rd = fakeRaindrop([newest, older])

    const result = await pollRaindrops({ client: rd.client, db: db.client, collectionId: '4242' })
    expect(result.ingested).toHaveLength(51)
    // The high-water mark, not the last drop seen.
    expect(result.cursor).toBe(raindropCursor(newest[49]))
  })

  it('advances past a link already in the pipeline instead of retrying it forever', async () => {
    const db = fakeDb()
    db.seenUrlKeys.add('e.com/a')
    const page = [drop(1, '2026-08-30T10:00:00Z', 'https://e.com/a')]
    const rd = fakeRaindrop([page])

    const result = await pollRaindrops({ client: rd.client, db: db.client, collectionId: '4242' })
    expect(result.ingested).toHaveLength(0)
    expect(result.scanned).toBe(1)
    expect(result.cursor).toBe(raindropCursor(page[0]))
  })
})

// ── Email: the shared secret ─────────────────────────────────────────────────

describe('secretMatches', () => {
  it('accepts only the exact secret', () => {
    expect(secretMatches('shh', 'shh')).toBe(true)
    expect(secretMatches('shhh', 'shh')).toBe(false)
    expect(secretMatches('sh', 'shh')).toBe(false)
    expect(secretMatches('', 'shh')).toBe(false)
    expect(secretMatches(null, 'shh')).toBe(false)
    expect(secretMatches(undefined, 'shh')).toBe(false)
  })

  it('never accepts anything when no secret is configured', () => {
    expect(secretMatches('', '')).toBe(false)
    expect(secretMatches('anything', '')).toBe(false)
  })
})

// ── Email: classification ────────────────────────────────────────────────────

describe('classifyMail', () => {
  const allow = ['letters@coldcomfort.example.com']

  it('recognises an allowlisted newsletter, case-insensitively', async () => {
    const mail = await parse(mime({ from: 'Letters@ColdComfort.Example.com', html: '<h1>Hi</h1><p>Body</p>' }))
    expect(isAllowlistedNewsletter(mail, allow)).toBe(true)
    expect(classifyMail(mail, allow)).toBe('newsletter')
  })

  it('does not treat every newsletter as printable — the allowlist is the intent signal', async () => {
    const mail = await parse(mime({ from: 'digest@othersubstack.example.com', html: '<h1>Hi</h1><p>Body</p>' }))
    expect(classifyMail(mail, allow)).not.toBe('newsletter')
  })

  it('recognises the Gmail forwarding confirmation', async () => {
    const mail = await parse(
      mime({ from: GMAIL_FORWARDING_SENDER, subject: 'Gmail Forwarding Confirmation', text: 'Code: 123456789' }),
    )
    expect(classifyMail(mail, allow)).toBe('gmail_verification')
  })

  it('recognises a bare link drop', async () => {
    const mail = await parse(mime({ text: 'https://example.com/read-this' }))
    expect(classifyMail(mail, allow)).toBe('link')
  })
})

describe('extractUrls', () => {
  it('finds every link in a drop', () => {
    expect(
      extractUrls({ text: 'two of them:\nhttps://a.example.com/one\nhttps://b.example.com/two', html: undefined }),
    ).toEqual(['https://a.example.com/one', 'https://b.example.com/two'])
  })

  it('does not report the same link twice', () => {
    expect(extractUrls({ text: 'https://a.example.com/x https://a.example.com/x', html: undefined })).toEqual([
      'https://a.example.com/x',
    ])
  })

  it('ignores non-http schemes', () => {
    expect(extractUrls({ text: 'mailto:a@b.com ftp://x/y', html: undefined })).toEqual([])
  })
})

// ── Email: PDF normalization ─────────────────────────────────────────────────

async function makePdf(pages: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const [w, h] of pages) {
    // Real content: pdf-lib refuses to embed a page with no content stream,
    // and a fixture of empty pages would test the degraded path by accident.
    doc.addPage([w, h]).drawRectangle({ x: 20, y: 20, width: w - 40, height: h - 40 })
  }
  return doc.save()
}

describe('normalizePdfToMediaBox', () => {
  it('rescales A4 onto the 7x10-plus-bleed page Lulu expects', async () => {
    const a4 = await makePdf([[595.28, 841.89]])
    const { pdf, pageCount } = await normalizePdfToMediaBox(a4)
    expect(pageCount).toBe(1)

    const out = await PDFDocument.load(pdf)
    const { width, height } = out.getPage(0).getSize()
    expect(width).toBeCloseTo(MEDIA_WIDTH_PT, 2)
    expect(height).toBeCloseTo(MEDIA_HEIGHT_PT, 2)
  })

  it('normalizes every page of a mixed-size document and counts them all', async () => {
    const mixed = await makePdf([
      [595.28, 841.89], // A4 portrait
      [612, 792], // US Letter
      [792, 612], // Letter landscape
    ])
    const { pdf, pageCount } = await normalizePdfToMediaBox(mixed)
    expect(pageCount).toBe(3)

    const out = await PDFDocument.load(pdf)
    for (const page of out.getPages()) {
      expect(page.getSize().width).toBeCloseTo(MEDIA_WIDTH_PT, 2)
      expect(page.getSize().height).toBeCloseTo(MEDIA_HEIGHT_PT, 2)
    }
  })

  it('keeps a blank page rather than losing the whole document to it', async () => {
    // pdf-lib refuses to embed a page with no content stream. One deliberate
    // blank in a report must not cost the upload, and must not shift the
    // pagination either — the sheet is still emitted, just empty.
    const doc = await PDFDocument.create()
    doc.addPage([612, 792]).drawRectangle({ x: 20, y: 20, width: 100, height: 100 })
    doc.addPage([612, 792]) // no content stream at all
    const { pdf, pageCount } = await normalizePdfToMediaBox(await doc.save())

    expect(pageCount).toBe(2)
    const out = await PDFDocument.load(pdf)
    expect(out.getPage(1).getSize().width).toBeCloseTo(MEDIA_WIDTH_PT, 2)
  })

  it('marks the trim box inside the bleed so the printer knows where to cut', async () => {
    const { pdf } = await normalizePdfToMediaBox(await makePdf([[612, 792]]))
    const out = await PDFDocument.load(pdf)
    const trim = out.getPage(0).getTrimBox()
    expect(trim.width).toBeCloseTo(504, 2) // 7in
    expect(trim.height).toBeCloseTo(720, 2) // 10in
  })
})

// ── Email: ingestion end to end ──────────────────────────────────────────────

import PostalMime from 'postal-mime'
const parse = (raw: string) => PostalMime.parse(new TextEncoder().encode(raw))

describe('ingestEmail', () => {
  it('stores the raw message before classifying anything', async () => {
    const db = fakeDb()
    const result = await ingestEmail(mime({ text: 'nothing useful here' }), {
      db: db.client,
      settings: settings(),
    })
    expect(result.rawEmailPath).toMatch(/^raw-email\/.+\.eml$/)
    expect(db.objects.has(result.rawEmailPath)).toBe(true)
  })

  it('queues an emailed link and mirrors it into hw so Raindrop stays the one list', async () => {
    const db = fakeDb()
    const rd = fakeRaindrop()
    const result = await ingestEmail(mime({ text: 'https://example.com/a-piece' }), {
      db: db.client,
      settings: settings(),
      raindrop: rd.client,
    })

    expect(result.kind).toBe('link')
    expect(result.items).toHaveLength(1)
    expect(rd.created).toEqual([{ link: 'https://example.com/a-piece', collectionId: '4242' }])
    // The id of the mirrored raindrop is stored, or U9 could not archive it.
    expect(result.items[0].source).toBe('email_link')
    expect(String(result.items[0].raindrop_id)).toMatch(/^\d+$/)
    expect(db.updated.some((u) => u.patch.raindrop_id)).toBe(true)
  })

  it('makes one item per link when a mail carries two', async () => {
    const db = fakeDb()
    const rd = fakeRaindrop()
    const result = await ingestEmail(
      mime({ text: 'both of these:\nhttps://a.example.com/one\nhttps://b.example.com/two' }),
      { db: db.client, settings: settings(), raindrop: rd.client },
    )
    expect(result.items).toHaveLength(2)
    expect(rd.created.map((c) => c.link)).toEqual([
      'https://a.example.com/one',
      'https://b.example.com/two',
    ])
  })

  it('keeps a newsletter’s HTML, remote images and all, for U3 to resolve', async () => {
    const db = fakeDb()
    const html =
      '<h1>The Longest Winter</h1><p>Body text.</p><img src="https://substackcdn.com/image/frost.jpg">'
    const result = await ingestEmail(
      mime({ from: 'letters@coldcomfort.example.com', subject: 'The Longest Winter', html }),
      { db: db.client, settings: settings() },
    )

    expect(result.kind).toBe('newsletter')
    expect(result.items).toHaveLength(1)
    const path = newsletterHtmlPath(result.items[0].id)
    expect(db.objects.get(path)).toContain('substackcdn.com')
    // No url — a newsletter has no canonical link worth deduping on.
    expect(result.items[0].url ?? null).toBeNull()
  })

  it('turns an attached PDF into a ready-made page fragment', async () => {
    const db = fakeDb()
    const bytes = await makePdf([[595.28, 841.89], [595.28, 841.89]])
    const base64 = Buffer.from(bytes).toString('base64')

    const result = await ingestEmail(
      mime({ subject: 'A report', pdf: { filename: 'report.pdf', base64 } }),
      { db: db.client, settings: settings() },
    )

    expect(result.kind).toBe('pdf')
    expect(result.items).toHaveLength(1)
    const item = result.items[0] as PressItem
    expect(item.page_count).toBe(2)
    // It needs no extraction or layout, so it enters the pipeline already laid out.
    expect(item.state).toBe('laid_out')

    const fragment = db.objects.get(`items/${item.id}/fragment.pdf`) as Uint8Array
    expect(fragment).toBeInstanceOf(Uint8Array)
    const out = await PDFDocument.load(fragment)
    expect(out.getPage(0).getSize().width).toBeCloseTo(MEDIA_WIDTH_PT, 2)
  })

  it('relays the Gmail verification code instead of ingesting it', async () => {
    const db = fakeDb()
    const sent: RequestInit[] = []
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      sent.push(init)
      return new Response('{}', { status: 200 })
    })

    const result = await ingestEmail(
      mime({
        from: GMAIL_FORWARDING_SENDER,
        subject: 'Gmail Forwarding Confirmation - Receive Mail from press@example.com',
        text: 'Confirmation code: 987654321',
      }),
      { db: db.client, settings: settings(), fetchImpl: fetchImpl as never },
    )

    expect(result.relayed).toBe(true)
    expect(result.items).toHaveLength(0)
    expect(sent).toHaveLength(1)
    // It went to the owner, and the code survived the relay.
    const body = JSON.parse(String(sent[0].body))
    expect(body.to).toContain('owner@example.com')
    expect(JSON.stringify(body)).toContain('987654321')
  })

  it('stores an unrecognised mail without queueing it', async () => {
    const db = fakeDb()
    const result = await ingestEmail(mime({ from: 'stranger@example.com', text: 'hello?' }), {
      db: db.client,
      settings: settings(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.items).toHaveLength(0)
    expect(db.objects.has(result.rawEmailPath)).toBe(true)
  })
})

// ── The webhook route ────────────────────────────────────────────────────────

describe('POST /api/press/email-in', () => {
  const load = async () => (await import('@/app/api/press/email-in/route')).POST

  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    vi.resetModules()
  })

  it('rejects a request with no secret, without ingesting anything', async () => {
    process.env.PRESS_EMAIL_WEBHOOK_SECRET = 'shh'
    const email = await import('@/lib/press/email')
    const ingest = vi.spyOn(email, 'ingestEmail')
    const POST = await load()

    const res = await POST(
      new Request('https://app/api/press/email-in', { method: 'POST', body: mime({ text: 'x' }) }),
    )
    expect(res.status).toBe(401)
    // The body was never handed to the pipeline.
    expect(ingest).not.toHaveBeenCalled()
    ingest.mockRestore()
  })

  it('rejects a wrong secret', async () => {
    process.env.PRESS_EMAIL_WEBHOOK_SECRET = 'shh'
    const POST = await load()
    const res = await POST(
      new Request('https://app/api/press/email-in', {
        method: 'POST',
        headers: { 'x-press-secret': 'guess' },
        body: 'raw',
      }),
    )
    expect(res.status).toBe(401)
  })

  it('refuses to run at all while unconfigured, rather than accepting anything', async () => {
    delete process.env.PRESS_EMAIL_WEBHOOK_SECRET
    const POST = await load()
    const res = await POST(
      new Request('https://app/api/press/email-in', {
        method: 'POST',
        headers: { 'x-press-secret': '' },
        body: 'raw',
      }),
    )
    expect(res.status).toBe(503)
  })

  it('rejects an empty delivery', async () => {
    process.env.PRESS_EMAIL_WEBHOOK_SECRET = 'shh'
    const POST = await load()
    const res = await POST(
      new Request('https://app/api/press/email-in', {
        method: 'POST',
        headers: { 'x-press-secret': 'shh' },
        body: '',
      }),
    )
    expect(res.status).toBe(400)
  })
})
