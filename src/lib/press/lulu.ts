/**
 * press — Lulu Print API client (U6, KTD1).
 *
 * Deliberately Lulu-shaped rather than a generic print abstraction: Bookvault
 * and Peecho are named as fallbacks in the plan but nothing is wired to them,
 * and a vendor-neutral interface written against one vendor is a guess.
 *
 * Sandbox by default. Production is opt-in through LULU_SANDBOX=false, so a
 * misconfigured environment cannot spend money by accident.
 */

import { loadSettings, type PressSettings } from './settings'
import { LULU_PACKAGE_ID, type PrintQuote } from './types'

export const LULU_SANDBOX_BASE = 'https://api.sandbox.lulu.com'
export const LULU_PRODUCTION_BASE = 'https://api.lulu.com'

export class LuluError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'LuluError'
  }
}

export interface ShippingAddress {
  name: string
  street1: string
  street2: string | null
  city: string
  stateCode: string
  postcode: string
  countryCode: string
  phone: string
}

export interface LineItem {
  title: string
  packageId: string
  pageCount: number
  interiorUrl: string
  coverUrl: string
  quantity: number
  /**
   * Identifies this line back to the order row it was placed for.
   *
   * A one-issue job does not need it — there is only one line and only one
   * row. A bundle does: Lulu reports file validation per line item, and
   * "issue 3's interior was refused" has to reach issue 3's row and no other.
   */
  externalId?: string
}

/** What pricing needs. The files are not fetched to quote, so they are absent. */
export type QuoteLine = Omit<LineItem, 'interiorUrl' | 'coverUrl'>

/** One line of a job as Lulu reports it back. */
export interface PrintJobLine {
  externalId: string | null
  title: string | null
  status: string | null
  message: string | null
  trackingUrls: string[]
}

export interface PrintJob {
  id: string
  status: string
  /**
   * Lulu's line-item status for the FIRST line, where a file-validation
   * failure shows up. Correct for a single-line job, which is every job press
   * placed before bundling; `lines` is the answer for a bundle.
   */
  lineItemStatus: string | null
  /** Every line, in the order Lulu returned them. */
  lines: PrintJobLine[]
  message: string | null
  trackingUrls: string[]
}

export interface LuluClient {
  /**
   * Price a job. One line or several — several is the point: Lulu charges
   * shipping per job, not per book, so two issues in one job cost one parcel.
   */
  quote(lines: QuoteLine | QuoteLine[], address: ShippingAddress): Promise<PrintQuote>
  createPrintJob(opts: {
    /** One item, or the several that make up a bundle. */
    item?: LineItem
    items?: LineItem[]
    address: ShippingAddress
    externalId: string
    idempotencyKey: string
  }): Promise<PrintJob>
  getPrintJob(jobId: string): Promise<PrintJob>
}

/**
 * Which line of a job belongs to a given order row.
 *
 * By external id where Lulu echoes one back, because that is the only mapping
 * that survives the API reordering the array. Where it does not, position is
 * what we have — the lines were sent in a known order, and for the single-line
 * jobs that predate bundling the two agree anyway.
 */
export function lineFor(job: PrintJob, externalId: string | null, index: number): PrintJobLine | null {
  if (externalId) {
    const byId = job.lines.find((l) => l.externalId === externalId)
    if (byId) return byId
  }
  return job.lines[index] ?? job.lines[0] ?? null
}

export interface LuluClientOptions {
  settings?: PressSettings
  fetchImpl?: typeof fetch
  /** Overrides the sandbox/production choice; tests point it at a stub. */
  baseUrl?: string
}

/** Lulu's shipping levels; the cheapest that still arrives is the right default. */
export const SHIPPING_LEVEL = 'MAIL'

interface TokenState {
  token: string
  expiresAt: number
}

function normalizeStatus(payload: Record<string, unknown>): PrintJob {
  const status = payload.status as { name?: string; message?: string } | undefined
  const lineItems = (payload.line_items as Array<Record<string, unknown>>) ?? []

  const lines: PrintJobLine[] = lineItems.map((li) => {
    const s = li.status as { name?: string; message?: string } | undefined
    return {
      externalId: li.external_id ? String(li.external_id) : null,
      title: li.title ? String(li.title) : null,
      status: s?.name ?? null,
      message: s?.message ?? null,
      trackingUrls: ((li.tracking_urls as string[]) ?? []).filter(Boolean),
    }
  })

  return {
    id: String(payload.id ?? ''),
    status: status?.name ?? 'UNKNOWN',
    lineItemStatus: lines.map((l) => l.status).find(Boolean) ?? null,
    lines,
    message: status?.message ?? null,
    trackingUrls: lines.flatMap((l) => l.trackingUrls),
  }
}

/** Lulu reports a refused file through the line item, not the job status. */
export function isRejected(job: PrintJob): boolean {
  return job.status === 'REJECTED' || job.lines.some((l) => l.status === 'REJECTED')
}

export function isShipped(job: PrintJob): boolean {
  return job.status === 'SHIPPED'
}

export function createLuluClient(options: LuluClientOptions = {}): LuluClient {
  const settings = options.settings ?? loadSettings()
  const doFetch = options.fetchImpl ?? fetch
  const baseUrl =
    options.baseUrl ?? (settings.luluSandbox ? LULU_SANDBOX_BASE : LULU_PRODUCTION_BASE)

  let token: TokenState | null = null

  async function accessToken(): Promise<string> {
    // A minute of slack, so a token cannot expire between check and use.
    if (token && token.expiresAt > Date.now() + 60_000) return token.token

    const res = await doFetch(`${baseUrl}/auth/realms/glasstree/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: settings.luluClientKey,
        client_secret: settings.luluClientSecret,
      }),
    })
    if (!res.ok) {
      throw new LuluError(`lulu auth failed (${res.status})`, res.status, await res.text().catch(() => ''))
    }
    const body = (await res.json()) as { access_token: string; expires_in: number }
    token = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
    return token.token
  }

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      // Leave it as text; the error path prints it.
    }
    if (!res.ok) {
      throw new LuluError(`lulu ${init.method ?? 'GET'} ${path} failed (${res.status})`, res.status, body)
    }
    return body
  }

  function addressPayload(address: ShippingAddress) {
    return {
      name: address.name,
      street1: address.street1,
      ...(address.street2 ? { street2: address.street2 } : {}),
      city: address.city,
      state_code: address.stateCode,
      postcode: address.postcode,
      country_code: address.countryCode,
      phone_number: address.phone,
    }
  }

  return {
    async quote(lines, address) {
      const items = Array.isArray(lines) ? lines : [lines]
      const body = (await call('/print-job-cost-calculations/', {
        method: 'POST',
        body: JSON.stringify({
          line_items: items.map((item) => ({
            page_count: item.pageCount,
            pod_package_id: item.packageId || LULU_PACKAGE_ID,
            quantity: item.quantity,
          })),
          shipping_address: addressPayload(address),
          shipping_option: SHIPPING_LEVEL,
        }),
      })) as Record<string, unknown>

      const total = body.total_cost_incl_tax ?? body.total_cost_excl_tax
      const shipping = (body.shipping_cost as Record<string, unknown> | undefined)?.total_cost_incl_tax
      const lineCosts = (body.line_item_costs as Array<Record<string, unknown>> | undefined) ?? []

      const cents = (v: unknown): number | null =>
        v === null || v === undefined ? null : Math.round(Number(v) * 100)

      const lineCents = items.map((_, i) => cents(lineCosts[i]?.total_cost_incl_tax))
      // The job's print cost is every line, not the first one. With a single
      // line — every job press placed before bundling — this is the same
      // number it always was.
      const printCents = lineCents.every((c) => c === null)
        ? null
        : lineCents.reduce<number>((a, c) => a + (c ?? 0), 0)

      return {
        totalCents: cents(total) ?? 0,
        currency: String(body.currency ?? 'USD'),
        shippingCents: cents(shipping),
        printCents,
        lineCents,
      }
    },

    async createPrintJob({ item, items, address, externalId, idempotencyKey }) {
      const lines = items ?? (item ? [item] : [])
      if (lines.length === 0) throw new Error('lulu: a print job needs at least one line item')

      const body = (await call('/print-jobs/', {
        method: 'POST',
        headers: {
          // Belt to the database's braces: even if press_place_order were
          // somehow bypassed, Lulu should collapse the duplicate itself.
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          external_id: externalId,
          line_items: lines.map((line) => ({
            title: line.title,
            ...(line.externalId ? { external_id: line.externalId } : {}),
            cover_source_url: line.coverUrl,
            interior_source_url: line.interiorUrl,
            pod_package_id: line.packageId || LULU_PACKAGE_ID,
            page_count: line.pageCount,
            quantity: line.quantity,
          })),
          shipping_address: addressPayload(address),
          shipping_level: SHIPPING_LEVEL,
        }),
      })) as Record<string, unknown>
      return normalizeStatus(body)
    },

    async getPrintJob(jobId) {
      return normalizeStatus((await call(`/print-jobs/${jobId}/`)) as Record<string, unknown>)
    },
  }
}

/** Formats a quote for the approval email. Cost is stated before anything is spent. */
export function formatQuote(quote: PrintQuote): string {
  const money = (cents: number | null) =>
    cents === null ? '—' : `${(cents / 100).toFixed(2)} ${quote.currency}`
  const parts = [`${money(quote.totalCents)} total`]
  if (quote.printCents !== null) parts.push(`${money(quote.printCents)} print`)
  if (quote.shippingCents !== null) parts.push(`${money(quote.shippingCents)} shipping`)
  return parts.join(' · ')
}
