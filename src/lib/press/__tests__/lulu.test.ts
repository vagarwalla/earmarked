import { describe, it, expect, vi } from 'vitest'
import {
  createLuluClient,
  formatQuote,
  isRejected,
  isShipped,
  LuluError,
  LULU_SANDBOX_BASE,
  LULU_PRODUCTION_BASE,
  type ShippingAddress,
} from '../lulu'
import {
  hashToken,
  generateToken,
  tokensEqual,
  issueActionTokens,
  inspectToken,
  claimToken,
  approvalHtml,
  approvalSubject,
  sendMail,
  TOKEN_TTL_DAYS,
} from '../approval'
import { performApproval } from '../order'
import type { PressSettings } from '../settings'
import type { PressIssue, PrintQuote, TocEntry } from '../types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const address: ShippingAddress = {
  name: 'A Reader',
  street1: '1 Example Street',
  street2: null,
  city: 'Exampleton',
  stateCode: 'CA',
  postcode: '00000',
  countryCode: 'US',
  phone: '5550000000',
}

function settings(over: Partial<PressSettings> = {}): PressSettings {
  return {
    supabaseUrl: 'https://x.supabase.co',
    supabaseServiceKey: 'service',
    storageBucket: 'press',
    raindropToken: '',
    raindropCollectionId: '',
    emailWebhookSecret: '',
    resendApiKey: 're_key',
    mailFrom: 'press@example.com',
    mailTo: 'owner@example.com',
    newsletterAllowlist: [],
    luluClientKey: 'key',
    luluClientSecret: 'secret',
    luluSandbox: true,
    luluPackageId: '0700X1000.FC.STD.PB.060UW444.GXX',
    anthropicApiKey: null,
    shipping: address,
    pageThreshold: 100,
    maxIssueAgeWeeks: 8,
    appUrl: 'https://app.example.com',
    actionTokenSecret: 'tok',
    ...over,
  }
}

function issue(over: Partial<PressIssue> = {}): PressIssue {
  return {
    id: 'iss1',
    number: 3,
    state: 'closed',
    name: 'Winter Light',
    page_total: 100,
    interior_path: 'issues/iss1/interior.pdf',
    cover_path: 'issues/iss1/cover.pdf',
    quote_cents: null,
    quote_currency: null,
    lulu_job_id: null,
    lulu_idempotency_key: null,
    lulu_status: null,
    tracking_url: null,
    archive_collection_id: null,
    built_order: null,
    rejection_reason: null,
    opened_at: '2026-07-01T00:00:00Z',
    closed_at: '2026-08-30T00:00:00Z',
    approved_at: null,
    ordered_at: null,
    shipped_at: null,
    approval_sent_at: null,
    updated_at: '2026-08-30T00:00:00Z',
    ...over,
  }
}

/** A fetch that answers Lulu's auth call and then whatever the test supplies. */
function luluFetch(handler: (url: string, init: RequestInit) => unknown, status = 200) {
  return vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const href = String(url)
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }
    const body = handler(href, init)
    return new Response(JSON.stringify(body ?? {}), { status })
  })
}

// ── The Lulu client ──────────────────────────────────────────────────────────

describe('createLuluClient', () => {
  it('talks to the sandbox unless production is explicit', async () => {
    const seen: string[] = []
    const fetchImpl = luluFetch((url) => {
      seen.push(url)
      return { total_cost_incl_tax: '8.51', currency: 'USD' }
    })
    await createLuluClient({ settings: settings(), fetchImpl: fetchImpl as never }).quote(
      { title: 'x', packageId: 'pkg', pageCount: 100, quantity: 1 },
      address,
    )
    expect(seen.every((u) => u.startsWith(LULU_SANDBOX_BASE))).toBe(true)

    seen.length = 0
    await createLuluClient({
      settings: settings({ luluSandbox: false }),
      fetchImpl: fetchImpl as never,
    }).quote({ title: 'x', packageId: 'pkg', pageCount: 100, quantity: 1 }, address)
    expect(seen.every((u) => u.startsWith(LULU_PRODUCTION_BASE))).toBe(true)
  })

  it('itemizes a quote in cents', async () => {
    const fetchImpl = luluFetch(() => ({
      total_cost_incl_tax: '13.24',
      currency: 'USD',
      shipping_cost: { total_cost_incl_tax: '4.73' },
      line_item_costs: [{ total_cost_incl_tax: '8.51' }],
    }))
    const quote = await createLuluClient({ settings: settings(), fetchImpl: fetchImpl as never }).quote(
      { title: 'Winter Light', packageId: 'pkg', pageCount: 100, quantity: 1 },
      address,
    )
    // The plan's verified figure for a 100pp standard-colour interior.
    expect(quote.printCents).toBe(851)
    expect(quote.shippingCents).toBe(473)
    expect(quote.totalCents).toBe(1324)
    expect(quote.currency).toBe('USD')
  })

  it('reuses the access token rather than re-authenticating per call', async () => {
    let auths = 0
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes('openid-connect/token')) {
        auths++
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
      }
      return new Response(JSON.stringify({ total_cost_incl_tax: '1.00', currency: 'USD' }), { status: 200 })
    })
    const client = createLuluClient({ settings: settings(), fetchImpl: fetchImpl as never })
    const line = { title: 'x', packageId: 'pkg', pageCount: 100, quantity: 1 }
    await client.quote(line, address)
    await client.quote(line, address)
    expect(auths).toBe(1)
  })

  it('sends the idempotency key with a print job', async () => {
    let headers: Headers | null = null
    const fetchImpl = luluFetch((_url, init) => {
      headers = new Headers(init.headers)
      return { id: 42, status: { name: 'CREATED' } }
    })
    await createLuluClient({ settings: settings(), fetchImpl: fetchImpl as never }).createPrintJob({
      item: {
        title: 'Winter Light',
        packageId: 'pkg',
        pageCount: 100,
        interiorUrl: 'https://signed/interior',
        coverUrl: 'https://signed/cover',
        quantity: 1,
      },
      address,
      externalId: 'press-issue-iss1',
      idempotencyKey: 'press-issue-iss1',
    })
    expect(headers!.get('idempotency-key')).toBe('press-issue-iss1')
  })

  it('raises a typed error carrying the status', async () => {
    const fetchImpl = luluFetch(() => ({ detail: 'bad page count' }), 400)
    await expect(
      createLuluClient({ settings: settings(), fetchImpl: fetchImpl as never }).quote(
        { title: 'x', packageId: 'pkg', pageCount: 3, quantity: 1 },
        address,
      ),
    ).rejects.toThrow(LuluError)
  })
})

describe('job status', () => {
  it('spots a rejection reported on the line item, not the job', () => {
    expect(isRejected({ id: '1', status: 'IN_PRODUCTION', lineItemStatus: 'REJECTED', message: null, trackingUrls: [] })).toBe(true)
    expect(isRejected({ id: '1', status: 'REJECTED', lineItemStatus: null, message: null, trackingUrls: [] })).toBe(true)
    expect(isRejected({ id: '1', status: 'CREATED', lineItemStatus: 'CREATED', message: null, trackingUrls: [] })).toBe(false)
  })

  it('spots a shipped job', () => {
    expect(isShipped({ id: '1', status: 'SHIPPED', lineItemStatus: null, message: null, trackingUrls: [] })).toBe(true)
  })
})

describe('formatQuote', () => {
  it('states the cost before anything is spent', () => {
    const quote: PrintQuote = { totalCents: 1324, currency: 'USD', shippingCents: 473, printCents: 851 }
    expect(formatQuote(quote)).toBe('13.24 USD total · 8.51 USD print · 4.73 USD shipping')
  })
})

// ── Tokens ───────────────────────────────────────────────────────────────────

describe('action tokens', () => {
  it('stores only a hash, so a leaked row is not a working link', () => {
    const token = generateToken()
    const hash = hashToken(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(token)
    expect(hashToken(token)).toBe(hash)
  })

  it('generates distinct tokens', () => {
    expect(generateToken()).not.toBe(generateToken())
  })

  it('compares in constant time without throwing on length mismatch', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true)
    expect(tokensEqual('abc', 'abd')).toBe(false)
    expect(tokensEqual('abc', 'abcdef')).toBe(false)
  })
})

function tokenDb() {
  const rows = new Map<string, Record<string, unknown>>()
  const client = {
    from() {
      const b: Record<string, unknown> = {}
      let patch: Record<string, unknown> | null = null
      let hash: string | null = null
      b.select = () => b
      b.eq = (col: string, val: string) => {
        if (col === 'token_hash') hash = val
        if (patch && col === 'issue_id') {
          for (const row of rows.values()) if (row.issue_id === val && !row.used_at) row.used_at = patch.used_at
        }
        return b
      }
      b.is = () => b
      b.insert = (row: Record<string, unknown>) => {
        rows.set(String(row.token_hash), { ...row, used_at: null })
        return b
      }
      b.update = (p: Record<string, unknown>) => {
        patch = p
        return b
      }
      b.maybeSingle = async () => ({ data: hash ? (rows.get(hash) ?? null) : null, error: null })
      b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r)
      return b
    },
    rpc: async (fn: string, args: { p_token_hash?: string }) => {
      if (fn !== 'press_consume_token') return { data: null, error: null }
      const row = rows.get(String(args.p_token_hash))
      // Mirrors the SQL: only an unused, unexpired token is handed back.
      if (!row || row.used_at || new Date(String(row.expires_at)) <= new Date()) {
        return { data: null, error: null }
      }
      row.used_at = new Date().toISOString()
      return { data: row, error: null }
    },
  }
  return { client: client as never, rows }
}

describe('issueActionTokens', () => {
  it('mints one link per action and expires whatever was outstanding', async () => {
    const db = tokenDb()
    const first = await issueActionTokens('iss1', [{ action: 'approve' }], { db: db.client, settings: settings() })
    expect(first[0].url).toBe(`https://app.example.com/press/confirm/${first[0].token}`)

    const second = await issueActionTokens(
      'iss1',
      [{ action: 'approve' }, { action: 'skip' }, { action: 'drop', itemId: 'item9' }],
      { db: db.client, settings: settings() },
    )
    expect(second).toHaveLength(3)
    // A re-composed issue must not be approvable through the old link.
    expect(await inspectToken(first[0].token, { db: db.client })).toMatchObject({ ok: false, reason: 'used' })
  })

  it('gives tokens a life long enough to survive a buried inbox', async () => {
    const db = tokenDb()
    const now = new Date('2026-08-30T00:00:00Z')
    const [tok] = await issueActionTokens('iss1', [{ action: 'approve' }], {
      db: db.client,
      settings: settings(),
      now,
    })
    const row = db.rows.get(hashToken(tok.token))!
    const days = (new Date(String(row.expires_at)).getTime() - now.getTime()) / 86_400_000
    expect(days).toBeCloseTo(TOKEN_TTL_DAYS, 5)
  })
})

describe('inspectToken vs claimToken', () => {
  it('inspecting does not spend the token — this is what makes the GET safe', async () => {
    const db = tokenDb()
    const [tok] = await issueActionTokens('iss1', [{ action: 'approve' }], { db: db.client, settings: settings() })

    // A mail scanner previews the link, repeatedly.
    expect(await inspectToken(tok.token, { db: db.client })).toMatchObject({ ok: true })
    expect(await inspectToken(tok.token, { db: db.client })).toMatchObject({ ok: true })

    // V then actually confirms.
    expect(await claimToken(tok.token, { db: db.client })).toMatchObject({ ok: true })
    // And the link is spent.
    expect(await claimToken(tok.token, { db: db.client })).toMatchObject({ ok: false, reason: 'used' })
  })

  it('reports an unknown token distinctly from a spent one', async () => {
    const db = tokenDb()
    expect(await inspectToken('never-issued', { db: db.client })).toMatchObject({
      ok: false,
      reason: 'unknown',
    })
  })

  it('refuses an expired token', async () => {
    const db = tokenDb()
    const [tok] = await issueActionTokens('iss1', [{ action: 'approve' }], {
      db: db.client,
      settings: settings(),
      now: new Date(Date.now() - (TOKEN_TTL_DAYS + 1) * 86_400_000),
    })
    expect(await inspectToken(tok.token, { db: db.client })).toMatchObject({ ok: false, reason: 'expired' })
    expect(await claimToken(tok.token, { db: db.client })).toMatchObject({ ok: false, reason: 'expired' })
  })
})

// ── The approval email ───────────────────────────────────────────────────────

const toc: TocEntry[] = [
  { itemId: 'a', title: 'The Salt Roads', byline: 'Ada M', sourceName: 'Quarry', startPage: 3, pageCount: 4 },
  { itemId: 'b', title: 'The Longest Winter', byline: null, sourceName: 'Cold Comfort', startPage: 7, pageCount: 6 },
]

const emailInput = {
  issueNumber: 3,
  issueName: 'Winter Light',
  pageCount: 100,
  quote: { totalCents: 1324, currency: 'USD', shippingCents: 473, printCents: 851 } as PrintQuote,
  toc,
  previewUrl: 'https://signed/preview.pdf',
  approveUrl: 'https://app.example.com/press/confirm/tok-approve',
  skipUrl: 'https://app.example.com/press/confirm/tok-skip',
  dropUrls: new Map([
    ['a', 'https://app.example.com/press/confirm/tok-drop-a'],
    ['b', 'https://app.example.com/press/confirm/tok-drop-b'],
  ]),
}

describe('approval email', () => {
  it('names the issue and the exact cost in the subject and body', () => {
    expect(approvalSubject(emailInput)).toBe('press — Issue 3: Winter Light (100 pages)')
    const html = approvalHtml(emailInput)
    expect(html).toContain('13.24 USD total')
  })

  it('links the full interior, not a thumbnail — the last gate on a mangled extraction', () => {
    expect(approvalHtml(emailInput)).toContain('https://signed/preview.pdf')
  })

  it('offers a drop link for every article, so one bad piece does not sink the issue', () => {
    const html = approvalHtml(emailInput)
    expect(html).toContain('tok-drop-a')
    expect(html).toContain('tok-drop-b')
  })

  it('shows each article at the page it will actually be on', () => {
    const html = approvalHtml(emailInput)
    expect(html).toContain('p.3')
    expect(html).toContain('p.7')
  })

  it('says plainly that nothing is ordered by clicking', () => {
    expect(approvalHtml(emailInput)).toMatch(/Nothing is ordered until you confirm/)
  })

  it('escapes an article title that contains markup', () => {
    const html = approvalHtml({
      ...emailInput,
      toc: [{ ...toc[0], title: '<img src=x onerror=alert(1)>' }],
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('says so rather than inventing a price when Lulu did not quote', () => {
    expect(approvalHtml({ ...emailInput, quote: null })).toMatch(/no quote available/)
  })
})

describe('sendMail', () => {
  it('refuses to send while the mail settings are incomplete', async () => {
    await expect(
      sendMail({ subject: 's', html: 'h' }, { settings: settings({ resendApiKey: '' }) }),
    ).rejects.toThrow(/RESEND_API_KEY/)
  })

  it('surfaces a provider failure so the tick can retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 422 }))
    await expect(
      sendMail({ subject: 's', html: 'h' }, { settings: settings(), fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/422/)
  })
})

// ── Ordering ─────────────────────────────────────────────────────────────────

/**
 * A database whose order claim succeeds exactly once per idempotency key,
 * like `press_place_order` does.
 *
 * The claim moved out of `press_issues.lulu_job_id` and into a `press_orders`
 * row, which is what makes a second copy of a shipped issue expressible at
 * all. These fakes therefore have to answer for three tables rather than one.
 */
function orderDb(opts: { issueState?: string; address?: boolean } = {}) {
  const orders = new Map<string, Record<string, unknown>>()
  const updates: Record<string, unknown>[] = []
  const events: string[] = []
  let issueState = opts.issueState ?? 'closed'

  const settingsRow =
    opts.address === false
      ? null
      : {
          ship_name: 'V',
          ship_street1: '123 Test St',
          ship_street2: null,
          ship_city: 'San Francisco',
          ship_state: 'CA',
          ship_postcode: '94110',
          ship_country: 'US',
          ship_phone: '+15550001111',
          contact_email: 'v@example.com',
          page_threshold: 100,
          copies: 1,
          lulu_package_id: null,
          lulu_sandbox: true,
        }

  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {}
      let patch: Record<string, unknown> | null = null
      b.select = () => b
      b.eq = () => {
        if (patch) {
          updates.push(patch)
          if (table === 'press_issues' && patch.state) issueState = String(patch.state)
          if (table === 'press_orders') {
            for (const order of orders.values()) Object.assign(order, patch)
          }
          patch = null
        }
        return b
      }
      b.in = () => b
      b.is = () => b
      b.order = () => b
      b.limit = () => b
      b.update = (p: Record<string, unknown>) => {
        patch = p
        return b
      }
      b.insert = (row: Record<string, unknown>) => {
        if (table === 'press_events') events.push(String(row.kind))
        return b
      }
      b.upsert = () => b
      b.single = async () => ({ data: null, error: null })
      b.maybeSingle = async () => {
        if (table === 'press_settings') return { data: settingsRow, error: null }
        return { data: { ...issue(), state: issueState }, error: null }
      }
      b.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === 'press_orders' ? [...orders.values()] : [], error: null }).then(r)
      return b
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'press_place_order') return { data: null, error: null }
      const key = String(args.p_idempotency_key)
      // Idempotent on the key: the retry finds the first attempt's row.
      const existing = orders.get(key)
      if (existing) return { data: existing, error: null }
      if (!['closed', 'rejected', 'ordered', 'shipped'].includes(issueState)) {
        return { data: null, error: { message: `press_place_order: issue is ${issueState}` } }
      }
      const row = {
        id: `ord_${orders.size + 1}`,
        issue_id: String(args.p_issue_id),
        lulu_job_id: null,
        idempotency_key: key,
        status: 'pending',
        quantity: Number(args.p_quantity ?? 1),
        tracking_urls: [],
        ship_to: args.p_ship_to,
        ordered_by: args.p_ordered_by,
        placed_at: '2026-08-31T00:00:00.000Z',
        shipped_at: null,
      }
      orders.set(key, row)
      events.push('order_claimed')
      if (issueState === 'closed' || issueState === 'rejected') issueState = 'approved'
      return { data: row, error: null }
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null }),
      }),
    },
  }
  return { client: client as never, updates, events, orders }
}

function fakeLulu(job: Partial<{ id: string; status: string; lineItemStatus: string | null; message: string | null }> = {}) {
  const created: unknown[] = []
  return {
    created,
    client: {
      quote: async () => ({ totalCents: 1324, currency: 'USD', shippingCents: 473, printCents: 851 }),
      createPrintJob: async (opts: unknown) => {
        created.push(opts)
        return {
          id: job.id ?? 'job_1',
          status: job.status ?? 'CREATED',
          lineItemStatus: job.lineItemStatus ?? null,
          message: job.message ?? null,
          trackingUrls: [],
        }
      },
      getPrintJob: async () => ({ id: 'job_1', status: 'CREATED', lineItemStatus: null, message: null, trackingUrls: [] }),
    },
  }
}

describe('performApproval', () => {
  it('creates exactly one print job', async () => {
    const db = orderDb()
    const lulu = fakeLulu()
    const result = await performApproval(issue(), { db: db.client, lulu: lulu.client })
    expect(result).toMatchObject({ ok: true, status: 'ordered', jobId: 'job_1' })
    expect(lulu.created).toHaveLength(1)
    expect(db.events).toContain('order_placed')
  })

  it('cannot be made to order twice by a retry or a second tap', async () => {
    const db = orderDb()
    const lulu = fakeLulu()
    const first = await performApproval(issue(), { db: db.client, lulu: lulu.client })
    const second = await performApproval(issue(), { db: db.client, lulu: lulu.client })

    expect(first.status).toBe('ordered')
    expect(second.status).toBe('already-ordered')
    // The guarantee that matters: one job at Lulu, not two.
    expect(lulu.created).toHaveLength(1)
    expect(db.orders.size).toBe(1)
  })

  it('orders another copy of a shipped issue, which the old claim could not', async () => {
    const db = orderDb({ issueState: 'shipped' })
    const lulu = fakeLulu()

    const copy = await performApproval(issue({ state: 'shipped' }), {
      db: db.client,
      lulu: lulu.client,
      reorder: true,
    })

    expect(copy).toMatchObject({ ok: true, status: 'ordered' })
    expect(db.orders.size).toBe(1)
    // A reorder must not drag the issue back through its own state machine.
    expect(db.updates.some((u) => u.state === 'ordered')).toBe(false)
  })

  it('gives each extra copy its own claim rather than collapsing them', async () => {
    const db = orderDb({ issueState: 'shipped' })
    const lulu = fakeLulu()

    await performApproval(issue({ state: 'shipped' }), {
      db: db.client,
      lulu: lulu.client,
      reorder: true,
      now: new Date('2026-08-31T10:00:00Z'),
    })
    await performApproval(issue({ state: 'shipped' }), {
      db: db.client,
      lulu: lulu.client,
      reorder: true,
      now: new Date('2026-08-31T11:00:00Z'),
    })

    // Two deliberate purchases, unlike a retry of one.
    expect(db.orders.size).toBe(2)
    expect(lulu.created).toHaveLength(2)
  })

  it('sends the quantity from settings to Lulu', async () => {
    const db = orderDb()
    const lulu = fakeLulu()
    await performApproval(issue(), { db: db.client, lulu: lulu.client, quantity: 3 })
    expect((lulu.created[0] as { item: { quantity: number } }).item.quantity).toBe(3)
  })

  it('records a rejection against the issue and the order', async () => {
    const db = orderDb()
    const lulu = fakeLulu({ lineItemStatus: 'REJECTED', message: 'interior failed preflight' })
    const result = await performApproval(issue(), { db: db.client, lulu: lulu.client })
    expect(result).toMatchObject({ ok: false, status: 'rejected' })
    expect(db.updates.some((u) => u.state === 'rejected')).toBe(true)
    expect(db.events).toContain('order_rejected')
  })

  it('refuses an issue that was never composed', async () => {
    const db = orderDb()
    const result = await performApproval(issue({ interior_path: null }), {
      db: db.client,
      lulu: fakeLulu().client,
    })
    expect(result.status).toBe('not-composed')
  })

  it('refuses when there is no shipping address rather than failing at Lulu', async () => {
    const db = orderDb({ address: false })
    const result = await performApproval(issue(), { db: db.client, lulu: fakeLulu().client })
    expect(result.status).toBe('not-configured')
  })

  it('keeps the claim held when Lulu errors, so a retry cannot double-order', async () => {
    const db = orderDb()
    const lulu = {
      quote: async () => ({ totalCents: 0, currency: 'USD', shippingCents: null, printCents: null }),
      createPrintJob: async () => {
        throw new Error('gateway timeout')
      },
      getPrintJob: async () => ({ id: '', status: '', lineItemStatus: null, message: null, trackingUrls: [] }),
    }

    await expect(
      performApproval(issue(), { db: db.client, lulu: lulu as never }),
    ).rejects.toThrow(/gateway timeout/)
    expect(db.events).toContain('order_failed')

    // The row survives with no job id, so the key stays claimed and the retry
    // reconciles rather than buying a second copy.
    expect(db.orders.size).toBe(1)
  })
})
