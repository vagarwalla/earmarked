/**
 * press — ordering several issues as one parcel, from the outside.
 *
 * `lulu.test.ts` covers the placement itself. This covers what stands in front
 * of it: the quote that has to justify bundling before anything is sent, the
 * refusal that has to be entire rather than partial, and the email that has to
 * show a bundle rather than the first issue in it.
 */

import { describe, it, expect, vi } from 'vitest'
import { quoteBundle } from '../bundle'
import { groupByBundle, type OrderWithIssue } from '../orders'
import { bundleBlockers, orderBlockers, reorderBlockers } from '../workbench'
import { bundleApprovalHtml, bundleApprovalSubject } from '../approval'
import type { QuoteLine, ShippingAddress } from '../lulu'
import type { PressIssue, PressItem, PrintQuote } from '../types'

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

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  title: 'Winter Light',
  packageId: 'pkg',
  pageCount: 100,
  quantity: 1,
  ...over,
})

/**
 * Lulu's real prices for issues 1 and 2 (2026-09-01, 7×10 full colour, MAIL),
 * which are the numbers the whole feature exists for: $16.09 + $11.82 apart,
 * $22.72 together. The difference is one parcel and nothing else.
 */
function pricedLulu() {
  const quote = (lines: QuoteLine | QuoteLine[]): PrintQuote => {
    const items = Array.isArray(lines) ? lines : [lines]
    // Print cost tracks the book; shipping is charged once per JOB, which is
    // the whole asymmetry bundling exploits.
    const print = items.map((i) => (i.pageCount >= 100 ? 851 : 544))
    return {
      totalCents: print.reduce((a, b) => a + b, 0) + 758,
      currency: 'USD',
      shippingCents: 758,
      printCents: print.reduce((a, b) => a + b, 0),
      lineCents: print,
    }
  }
  return {
    quote: vi.fn(async (lines: QuoteLine | QuoteLine[]) => quote(lines)),
    createPrintJob: vi.fn(),
    getPrintJob: vi.fn(),
  }
}

describe('quoteBundle', () => {
  it('prices the job as it would be placed, and the jobs it replaces', async () => {
    const lulu = pricedLulu()
    const result = await quoteBundle([line(), line({ pageCount: 64 })], address, lulu as never)

    // One parcel for both, not one each.
    expect(result.quote?.totalCents).toBe(851 + 544 + 758)
    expect(result.separateTotalCents).toBe(851 + 758 + (544 + 758))
    expect(result.savingCents).toBe(758)
  })

  it('quotes the bundle once and each issue once — nothing is priced twice', async () => {
    const lulu = pricedLulu()
    await quoteBundle([line(), line()], address, lulu as never)
    expect(lulu.quote).toHaveBeenCalledTimes(3)
  })

  /**
   * A single issue has no alternative to be compared against: there is no
   * second parcel to avoid. Quoting it twice to prove a saving of zero is a
   * round trip spent on nothing.
   */
  it('does not shop a bundle of one against itself', async () => {
    const lulu = pricedLulu()
    const result = await quoteBundle([line()], address, lulu as never)
    expect(lulu.quote).toHaveBeenCalledTimes(1)
    expect(result.savingCents).toBeNull()
    expect(result.quote?.totalCents).toBe(851 + 758)
  })

  /**
   * There was a cap of six issues per parcel, and it existed to bound this
   * fan-out rather than the order — so the cap went and the fan-out stayed
   * bounded. A large selection still gets the price it is actually paying;
   * what it loses is the comparison, which is a flourish, not the purchase.
   */
  it('stops shopping the bundle around once the selection is large', async () => {
    const lulu = pricedLulu()
    const result = await quoteBundle(Array.from({ length: 9 }, () => line()), address, lulu as never)

    expect(lulu.quote).toHaveBeenCalledTimes(1)
    expect(result.quote?.totalCents).toBe(851 * 9 + 758)
    expect(result.separateTotalCents).toBeNull()
    expect(result.savingCents).toBeNull()
    // Still allocated, because the order rows are written from these.
    expect(result.perIssueCents).toHaveLength(9)
  })

  it('still compares a selection right up to the limit', async () => {
    const lulu = pricedLulu()
    const result = await quoteBundle(Array.from({ length: 6 }, () => line()), address, lulu as never)

    expect(lulu.quote).toHaveBeenCalledTimes(7)
    expect(result.savingCents).toBe(758 * 5)
  })

  it('splits the parcel over the issues so the shares sum to the total', async () => {
    const lulu = pricedLulu()
    const result = await quoteBundle([line(), line(), line()], address, lulu as never)
    const sum = (result.perIssueCents ?? []).reduce((a, b) => a + b, 0)
    expect(sum).toBe(result.quote?.totalCents)
  })

  /**
   * The bundled quote is the number about to be charged; the per-issue ones
   * only justify it. Losing the second must not lose the first.
   */
  it('keeps the bundled price when the comparison cannot be priced', async () => {
    const lulu = pricedLulu()
    lulu.quote.mockImplementation(async (lines: QuoteLine | QuoteLine[]) => {
      if (!Array.isArray(lines) || lines.length === 1) throw new Error('lulu 503')
      return {
        totalCents: 2272,
        currency: 'USD',
        shippingCents: 758,
        printCents: 1514,
        lineCents: [851, 663],
      }
    })
    const result = await quoteBundle([line(), line()], address, lulu as never)
    expect(result.quote?.totalCents).toBe(2272)
    expect(result.savingCents).toBeNull()
    expect(result.quoteError).toBeNull()
  })

  it('reports a dead quote rather than throwing, so the dialog can say so', async () => {
    const lulu = pricedLulu()
    lulu.quote.mockRejectedValue(new Error('lulu 503'))
    const result = await quoteBundle([line(), line()], address, lulu as never)
    expect(result.quote).toBeNull()
    expect(result.quoteError).toMatch(/503/)
  })
})

// ── The all-or-nothing gate ──────────────────────────────────────────────────

function issue(over: Partial<PressIssue> = {}): PressIssue {
  // A named, typed base rather than one literal: spreading a `Partial<T>`
  // over a `T` widens every field the partial declares back to `| undefined`,
  // so the result stops being a `T`. Annotating the base keeps the literal
  // contextually typed, and Object.assign keeps the override behaviour.
  const base: PressIssue = {
    // Owned, as every press row has been since migration 018. The factories
    // carry it so a test row is the shape the database actually stores.
    owner_id: '00000000-0000-0000-0000-000000000001',
    // Private until deliberately shared; the row has no implicit default,
    // so neither does the factory.
    visibility: 'private',
    shared_at: null,
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
  }
  return Object.assign(base, over)
}

const ready = {
  minPages: 32,
  hasAddress: true,
  hasEmail: true,
  openOrder: false,
  orderingEnabled: true,
}
const items: PressItem[] = []

describe('reorderBlockers', () => {
  /**
   * Found live: issue 1 sat at `ordered` with Lulu job 3022098 UNPAID — no
   * book printed, no money taken — and the bundle preview for it reported no
   * blockers at all. `isReorder` counts `ordered` as well as `shipped`, and
   * the filter then removed the one reason that mattered, so the workbench
   * would have sold a second copy and a second parcel of an issue whose first
   * order had not even been paid for.
   */
  it('still refuses an issue whose order is live', () => {
    expect(reorderBlockers(['An order for this issue is already in progress.'])).toEqual([
      'An order for this issue is already in progress.',
    ])
  })

  /**
   * And costs a real reorder nothing: a shipped issue's orders are finished,
   * so `openOrder` is false and that blocker was never in the list.
   */
  it('lets a genuinely finished issue be ordered again', () => {
    expect(reorderBlockers(['Lock the issue first — only a locked issue can be printed.'])).toEqual(
      [],
    )
  })
})

describe('bundleBlockers', () => {
  it('reads exactly like a single order when there is one issue', () => {
    const { blockers } = orderBlockers(issue({ state: 'open' }), items, ready)
    expect(bundleBlockers([{ number: 3, blockers }])).toEqual(blockers)
  })

  /**
   * The invariant: a Lulu job cannot be placed half-way, so one issue that is
   * not ready refuses the bundle entire. Ordering the rest would be quietly
   * doing something other than what was asked for — and would spend the
   * saving that was the reason for asking.
   */
  it('refuses the whole bundle when any one issue is blocked', () => {
    const fine = orderBlockers(issue({ number: 3 }), items, ready).blockers
    const broken = orderBlockers(issue({ number: 4, interior_path: null }), items, ready).blockers
    expect(fine).toEqual([])

    const blockers = bundleBlockers([
      { number: 3, blockers: fine },
      { number: 4, blockers: broken },
    ])
    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toBe('Issue 4: The issue has not been built.')
  })

  it('names the issue a reason belongs to, and states a shared one once', () => {
    const blockers = bundleBlockers([
      { number: 3, blockers: ['Ordering is off.', 'The issue has not been built.'] },
      { number: 4, blockers: ['Ordering is off.'] },
    ])
    expect(blockers).toEqual(['Ordering is off.', 'Issue 3: The issue has not been built.'])
  })

  it('refuses an empty selection rather than pricing nothing', () => {
    expect(bundleBlockers([])).toHaveLength(1)
  })
})

// ── The approval email ───────────────────────────────────────────────────────

const bundleEmail = {
  issues: [
    {
      number: 3,
      name: 'Winter Light',
      pageCount: 100,
      costCents: 1230,
      previewUrl: 'https://signed/3.pdf',
      toc: [
        { itemId: 'a', title: 'The Salt Roads', byline: 'Ada M', sourceName: 'Quarry', startPage: 1, pageCount: 4 },
      ],
    },
    {
      number: 4,
      name: 'The Long Thaw',
      pageCount: 64,
      costCents: 1042,
      previewUrl: 'https://signed/4.pdf',
      toc: [
        { itemId: 'b', title: 'The Longest Winter', byline: null, sourceName: 'Cold Comfort', startPage: 1, pageCount: 6 },
      ],
    },
  ],
  quote: {
    totalCents: 2272,
    currency: 'USD',
    shippingCents: 758,
    printCents: 1514,
    lineCents: [851, 663],
  } as PrintQuote,
  separateTotalCents: 2791,
  savingCents: 519,
  quantity: 1,
  approveUrl: 'https://app.example.com/press/confirm/tok-approve',
}

describe('the bundle approval email', () => {
  it('names every issue in the bundle, not just the first', () => {
    const html = bundleApprovalHtml(bundleEmail)
    expect(html).toContain('Winter Light')
    expect(html).toContain('The Long Thaw')
    expect(bundleApprovalSubject(bundleEmail)).toBe('press — 2 issues in one parcel: 22.72 USD')
  })

  /** The saving is the point of the email. Without it this is just a bill. */
  it('states what bundling saved against ordering them separately', () => {
    const html = bundleApprovalHtml(bundleEmail)
    expect(html).toContain('27.91 USD')
    expect(html).toContain('5.19 USD')
    expect(html).toMatch(/one parcel/i)
  })

  it('shows each issue with its pages and its share of the job', () => {
    const html = bundleApprovalHtml(bundleEmail)
    expect(html).toContain('100 pages')
    expect(html).toContain('64 pages')
    expect(html).toContain('12.30 USD')
    expect(html).toContain('10.42 USD')
  })

  it('lists what is in each issue, so a mangled extraction is still catchable', () => {
    const html = bundleApprovalHtml(bundleEmail)
    expect(html).toContain('The Salt Roads')
    expect(html).toContain('The Longest Winter')
    expect(html).toContain('https://signed/3.pdf')
    expect(html).toContain('https://signed/4.pdf')
  })

  it('says plainly that clicking orders nothing by itself', () => {
    expect(bundleApprovalHtml(bundleEmail)).toMatch(/Nothing is ordered until you confirm/)
  })

  it('escapes an issue name that contains markup', () => {
    const html = bundleApprovalHtml({
      ...bundleEmail,
      issues: [{ ...bundleEmail.issues[0], name: '<img src=x onerror=alert(1)>' }, bundleEmail.issues[1]],
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('says so rather than inventing a price when Lulu did not quote', () => {
    const html = bundleApprovalHtml({ ...bundleEmail, quote: null, savingCents: null, separateTotalCents: null })
    expect(html).toMatch(/no quote available/)
    expect(html).not.toMatch(/saving/i)
  })

  /**
   * A bundle of one is a legitimate thing to send — the dialog sends every
   * order down this path — and it must not claim a saving it did not make.
   */
  it('claims no saving for a bundle of one', () => {
    const html = bundleApprovalHtml({
      ...bundleEmail,
      issues: [bundleEmail.issues[0]],
      separateTotalCents: null,
      savingCents: null,
    })
    expect(html).not.toMatch(/saving/i)
    expect(bundleApprovalSubject({ ...bundleEmail, issues: [bundleEmail.issues[0]] })).toBe(
      'press — Issue 3: Winter Light (100 pages)',
    )
  })
})

// ── The orders panel ─────────────────────────────────────────────────────────

function order(over: Partial<OrderWithIssue> = {}): OrderWithIssue {
  return {
    id: 'ord1',
    issue_id: 'iss1',
    lulu_job_id: 'job_1',
    idempotency_key: 'press-issue-iss1',
    status: 'IN_PRODUCTION',
    line_item_status: 'CREATED',
    message: null,
    quantity: 1,
    cost_cents: 1088,
    currency: 'USD',
    tracking_urls: [],
    ship_to: null,
    ordered_by: null,
    bundle_key: null,
    line_index: 0,
    placed_at: '2026-09-01T00:00:00Z',
    shipped_at: null,
    updated_at: '2026-09-01T00:00:00Z',
    issue_number: 3,
    issue_name: 'Winter Light',
    ...over,
  }
}

describe('groupByBundle', () => {
  it('shows the rows of one job as one job, and totals what it charged', () => {
    const groups = groupByBundle([
      order({ id: 'a', bundle_key: 'press-bundle-iss1+iss2', issue_number: 3, cost_cents: 1088 }),
      order({ id: 'b', bundle_key: 'press-bundle-iss1+iss2', issue_number: 4, cost_cents: 1184 }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].orders.map((o) => o.issue_number)).toEqual([3, 4])
    // What was actually charged — not half of it, twice.
    expect(groups[0].totalCents).toBe(2272)
  })

  /** Every order placed before bundling existed. It is one issue, one job. */
  it('leaves an unbundled row as its own job', () => {
    const groups = groupByBundle([order({ id: 'a' }), order({ id: 'b', issue_number: 4 })])
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.orders.length === 1)).toBe(true)
  })

  it('keeps the newest-first order the panel was given', () => {
    const groups = groupByBundle([
      order({ id: 'a', issue_number: 9 }),
      order({ id: 'b', bundle_key: 'k', issue_number: 4 }),
      order({ id: 'c', issue_number: 8 }),
      order({ id: 'd', bundle_key: 'k', issue_number: 3 }),
    ])
    expect(groups.map((g) => g.orders[0].issue_number)).toEqual([9, 4, 8])
  })

  it('reports an unpriced job as unpriced rather than free', () => {
    const groups = groupByBundle([order({ id: 'a', bundle_key: 'k', cost_cents: null, currency: null })])
    expect(groups[0].totalCents).toBeNull()
  })
})
