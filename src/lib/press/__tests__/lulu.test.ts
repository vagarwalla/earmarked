import { describe, it, expect, vi } from 'vitest'
import {
  createLuluClient,
  formatQuote,
  isRejected,
  isShipped,
  LuluError,
  LULU_SANDBOX_BASE,
  LULU_PRODUCTION_BASE,
  lineFor,
  type PrintJob,
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
import { bundleKeyFor, performApproval, performBundledApproval, rowKeyFor } from '../order'
import type { PressSettings } from '../settings'
import { allocateQuote } from '../types'
import type { PressIssue, PrintQuote, TocEntry } from '../types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A job as Lulu reports it: an overall status, and one status per line. */
function printJob(status: string, lineStatuses: (string | null)[], ids: (string | null)[] = []): PrintJob {
  const lines = lineStatuses.map((s, i) => ({
    externalId: ids[i] ?? null,
    title: `line ${i}`,
    status: s,
    message: null,
    trackingUrls: [],
  }))
  return {
    id: 'job_1',
    status,
    lineItemStatus: lines.map((l) => l.status).find(Boolean) ?? null,
    lines,
    message: null,
    trackingUrls: [],
  }
}

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
    expect(isRejected(printJob('IN_PRODUCTION', ['REJECTED']))).toBe(true)
    expect(isRejected(printJob('REJECTED', []))).toBe(true)
    expect(isRejected(printJob('CREATED', ['CREATED']))).toBe(false)
  })

  /**
   * A bundle is one job carrying several issues. Lulu refusing any one of the
   * interiors is a rejection of the job, whichever line it lands on — reading
   * only the first would let a refused issue 4 sail past behind a healthy
   * issue 3.
   */
  it('spots a rejection on a line other than the first', () => {
    expect(isRejected(printJob('IN_PRODUCTION', ['CREATED', 'REJECTED']))).toBe(true)
  })

  it('spots a shipped job', () => {
    expect(isShipped(printJob('SHIPPED', []))).toBe(true)
  })
})

describe('formatQuote', () => {
  it('states the cost before anything is spent', () => {
    const quote: PrintQuote = {
      totalCents: 1324,
      currency: 'USD',
      shippingCents: 473,
      printCents: 851,
      lineCents: [851],
    }
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
  // Per issue, not one global: a bundle claims several issues in turn, and a
  // shared state variable would have the second one refused as 'approved'
  // because the first had just moved.
  const states = new Map<string, string>()
  const stateOf = (id: string) => states.get(id) ?? opts.issueState ?? 'closed'

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
      b.eq = (column?: string, value?: unknown) => {
        if (patch) {
          updates.push({ ...patch, ...(column ? { [`eq_${column}`]: value } : {}) })
          if (table === 'press_issues' && patch.state) states.set(String(value), String(patch.state))
          if (table === 'press_orders') {
            // Targeted, like the real update is. Applying a bundle's first
            // row's patch to every row would hide exactly the bug these tests
            // exist to catch.
            for (const order of orders.values()) {
              if (!column || order[column as string] === value) Object.assign(order, patch)
            }
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
        return { data: { ...issue(), state: stateOf('iss1') }, error: null }
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
      const issueId = String(args.p_issue_id)
      const state = stateOf(issueId)
      if (!['closed', 'rejected', 'ordered', 'shipped'].includes(state)) {
        return { data: null, error: { message: `press_place_order: issue is ${state}` } }
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
        bundle_key: (args.p_bundle_key as string | null) ?? null,
        line_index: Number(args.p_line_index ?? 0),
        placed_at: '2026-08-31T00:00:00.000Z',
        shipped_at: null,
      }
      orders.set(key, row)
      events.push('order_claimed')
      if (state === 'closed' || state === 'rejected') states.set(issueId, 'approved')
      return { data: row, error: null }
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null }),
      }),
    },
  }
  return { client: client as never, updates, events, orders, stateOf }
}

function fakeLulu(job: Partial<{ id: string; status: string; lineItemStatus: string | null; message: string | null }> = {}) {
  const created: unknown[] = []
  return {
    created,
    client: {
      quote: async (lines: unknown) => {
        const n = Array.isArray(lines) ? lines.length : 1
        return {
          totalCents: 1324,
          currency: 'USD',
          shippingCents: 473,
          printCents: 851 * n,
          lineCents: Array.from({ length: n }, () => 851),
        }
      },
      createPrintJob: async (opts: unknown) => {
        created.push(opts)
        const status = job.lineItemStatus ?? null
        return {
          id: job.id ?? 'job_1',
          status: job.status ?? 'CREATED',
          lineItemStatus: status,
          lines: ((opts as { items?: unknown[]; item?: unknown }).items ?? [(opts as { item: unknown }).item]).map(
            (line) => ({
              externalId: (line as { externalId?: string }).externalId ?? null,
              title: (line as { title?: string }).title ?? null,
              status,
              message: job.message ?? null,
              trackingUrls: [],
            }),
          ),
          message: job.message ?? null,
          trackingUrls: [],
        }
      },
      getPrintJob: async () => printJob('CREATED', []),
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
    expect((lulu.created[0] as { items: { quantity: number }[] }).items[0].quantity).toBe(3)
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
      quote: async () => ({
        totalCents: 0,
        currency: 'USD',
        shippingCents: null,
        printCents: null,
        lineCents: [null],
      }),
      createPrintJob: async () => {
        throw new Error('gateway timeout')
      },
      getPrintJob: async () => printJob('', []),
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


// ── Bundles ──────────────────────────────────────────────────────────────────
//
// Lulu charges shipping per job, not per book. Two issues in one job is one
// parcel and one shipping charge; the same two as separate jobs is two of
// each. Everything below exists to make that saving safe to take.

describe('allocateQuote', () => {
  it('gives each line its own print cost and an equal share of the one parcel', () => {
    const quote: PrintQuote = {
      totalCents: 2272,
      currency: 'USD',
      shippingCents: 694,
      printCents: 1503,
      lineCents: [965, 538],
    }
    const [first, second] = allocateQuote(quote, 2)
    expect(first).toBe(965 + 347)
    expect(second).toBe(538 + 347)
    expect(first + second).toBe(quote.totalCents - 75) // the rest is tax
  })

  /**
   * The parts have to sum to the shipping actually charged. A plain division
   * loses the odd cent, and a bundle of three would then be recorded as
   * costing less than it did — every time, forever.
   */
  it('never loses the odd cent when the parcel will not divide', () => {
    const quote: PrintQuote = {
      totalCents: 0,
      currency: 'USD',
      shippingCents: 100,
      printCents: 0,
      lineCents: [0, 0, 0],
    }
    const parts = allocateQuote(quote, 3)
    expect(parts).toEqual([34, 33, 33])
    expect(parts.reduce((a, c) => a + c, 0)).toBe(100)
  })

  it('still charges a line its share of the parcel when Lulu did not price it', () => {
    const quote: PrintQuote = {
      totalCents: 1000,
      currency: 'USD',
      shippingCents: 400,
      printCents: 600,
      lineCents: [600, null],
    }
    const parts = allocateQuote(quote, 2)
    expect(parts[1]).toBeGreaterThan(0)
  })
})

describe('bundle keys', () => {
  it('leaves a single issue with exactly the key it has always had', () => {
    const one = issue()
    expect(bundleKeyFor([one], false)).toBe('press-issue-iss1')
    expect(rowKeyFor(bundleKeyFor([one], false), one, false)).toBe('press-issue-iss1')
  })

  /**
   * A bundle re-driven after a timeout has to carry the SAME key to Lulu, or
   * the retry buys the parcel a second time. Deriving it from the issues means
   * it cannot drift, and sorting means the order they were passed in does not
   * change the answer.
   */
  it('is stable across a retry and independent of the order the issues came in', () => {
    const a = issue({ id: 'iss1' })
    const b = issue({ id: 'iss2' })
    expect(bundleKeyFor([a, b], false)).toBe(bundleKeyFor([b, a], false))
    expect(bundleKeyFor([a, b], false)).toBe('press-bundle-iss1+iss2')
  })

  it('marks a bundled reorder as a copy, so it is never mistaken for the print run', () => {
    const key = bundleKeyFor([issue({ id: 'iss1' }), issue({ id: 'iss2' })], true, new Date(1000))
    expect(key).toContain('-copy-')
  })

  it('gives each issue in a bundle its own row key', () => {
    const a = issue({ id: 'iss1' })
    const b = issue({ id: 'iss2' })
    const key = bundleKeyFor([a, b], false)
    expect(rowKeyFor(key, a, true)).not.toBe(rowKeyFor(key, b, true))
  })
})

describe('performBundledApproval', () => {
  const two = () => [issue({ id: 'iss1', number: 3 }), issue({ id: 'iss2', number: 4, name: 'Spring Tide' })]

  it('buys two issues as ONE job, which is the entire point', async () => {
    const db = orderDb()
    const lulu = fakeLulu()
    const result = await performBundledApproval(two(), { db: db.client, lulu: lulu.client })

    expect(result.ok).toBe(true)
    // One job at Lulu — one parcel, one shipping charge.
    expect(lulu.created).toHaveLength(1)
    expect((lulu.created[0] as { items: unknown[] }).items).toHaveLength(2)
    // Two rows, because everything downstream of an order is per issue.
    expect(db.orders.size).toBe(2)
    expect(result.issues.map((i) => i.issueNumber)).toEqual([3, 4])
  })

  it('ties the rows together and numbers their lines', async () => {
    const db = orderDb()
    await performBundledApproval(two(), { db: db.client, lulu: fakeLulu().client })
    const rows = [...db.orders.values()]
    expect(new Set(rows.map((r) => r.bundle_key)).size).toBe(1)
    expect(rows.map((r) => r.line_index)).toEqual([0, 1])
  })

  it('records what each issue cost, not what the parcel cost', async () => {
    const db = orderDb()
    await performBundledApproval(two(), { db: db.client, lulu: fakeLulu().client })
    const costs = [...db.orders.values()].map((r) => r.cost_cents as number)
    // 851 print each, plus half of the 473 shipping — not 1324 twice, which
    // is the whole bundle billed to both issues.
    expect(costs).toEqual([851 + 237, 851 + 236])
  })

  /**
   * The one that would hurt. Lulu validates each interior separately, so a
   * refused issue 4 must not drag issue 3 — printing perfectly well on the
   * next line of the same job — into 'rejected' beside it.
   */
  it('rejects only the issue whose own line Lulu refused', async () => {
    const db = orderDb()
    const lulu = {
      quote: async () => ({
        totalCents: 2272,
        currency: 'USD',
        shippingCents: 694,
        printCents: 1503,
        lineCents: [965, 538],
      }),
      createPrintJob: async (opts: { items: { externalId: string }[] }) => ({
        id: 'job_1',
        status: 'IN_PRODUCTION',
        lineItemStatus: 'CREATED',
        lines: [
          { externalId: opts.items[0].externalId, title: 'a', status: 'CREATED', message: null, trackingUrls: [] },
          {
            externalId: opts.items[1].externalId,
            title: 'b',
            status: 'REJECTED',
            message: 'interior failed preflight',
            trackingUrls: [],
          },
        ],
        message: null,
        trackingUrls: [],
      }),
      getPrintJob: async () => printJob('IN_PRODUCTION', []),
    }

    const result = await performBundledApproval(two(), { db: db.client, lulu: lulu as never })

    expect(result.ok).toBe(false)
    expect(result.issues[0]).toMatchObject({ ok: true, status: 'ordered', issueNumber: 3 })
    expect(result.issues[1]).toMatchObject({ ok: false, status: 'rejected', issueNumber: 4 })
    expect(db.stateOf('iss1')).toBe('ordered')
    expect(db.stateOf('iss2')).toBe('rejected')
  })

  /**
   * A job cannot be placed half-way. If one issue in the bundle is not ready,
   * the caller asked for a parcel that cannot be sent — quietly ordering the
   * rest would charge for a delivery they did not ask for.
   */
  it('refuses the whole bundle rather than ordering the issues that are ready', async () => {
    const db = orderDb()
    const lulu = fakeLulu()
    const issues = [issue({ id: 'iss1', number: 3 }), issue({ id: 'iss2', number: 4, interior_path: null })]
    const result = await performBundledApproval(issues, { db: db.client, lulu: lulu.client })

    expect(result.ok).toBe(false)
    expect(result.issues.every((i) => i.status === 'not-composed')).toBe(true)
    expect(lulu.created).toHaveLength(0)
    expect(db.orders.size).toBe(0)
  })

  it('cannot be made to buy the parcel twice by a retry', async () => {
    const db = orderDb()
    const lulu = fakeLulu()
    const first = await performBundledApproval(two(), { db: db.client, lulu: lulu.client })
    const second = await performBundledApproval(two(), { db: db.client, lulu: lulu.client })

    expect(first.issues.every((i) => i.status === 'ordered')).toBe(true)
    expect(second.issues.every((i) => i.status === 'already-ordered')).toBe(true)
    expect(lulu.created).toHaveLength(1)
    expect(db.orders.size).toBe(2)
  })

  it('sends each line the external id of its own row, so a verdict finds the right issue', async () => {
    const db = orderDb()
    const lulu = fakeLulu()
    await performBundledApproval(two(), { db: db.client, lulu: lulu.client })
    const sent = (lulu.created[0] as { items: { externalId: string }[] }).items
    const keys = [...db.orders.values()].map((r) => r.idempotency_key)
    expect(sent.map((i) => i.externalId)).toEqual(keys)
  })
})

describe('lineFor', () => {
  it('finds a line by its external id however Lulu ordered the array', () => {
    const job = printJob('CREATED', ['CREATED', 'REJECTED'], ['row-a', 'row-b'])
    expect(lineFor(job, 'row-b', 0)?.status).toBe('REJECTED')
  })

  it('falls back to position where Lulu echoed no id back', () => {
    const job = printJob('CREATED', ['CREATED', 'REJECTED'])
    expect(lineFor(job, 'row-b', 1)?.status).toBe('REJECTED')
  })
})
