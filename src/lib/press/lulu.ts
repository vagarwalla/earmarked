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
}

export interface PrintJob {
  id: string
  status: string
  /** Lulu's own line-item status, where a file-validation failure shows up. */
  lineItemStatus: string | null
  message: string | null
  trackingUrls: string[]
}

export interface LuluClient {
  quote(item: Omit<LineItem, 'interiorUrl' | 'coverUrl'>, address: ShippingAddress): Promise<PrintQuote>
  createPrintJob(opts: {
    item: LineItem
    address: ShippingAddress
    externalId: string
    idempotencyKey: string
  }): Promise<PrintJob>
  getPrintJob(jobId: string): Promise<PrintJob>
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
  const lineItemStatus = lineItems
    .map((li) => (li.status as { name?: string } | undefined)?.name)
    .find(Boolean)

  const trackingUrls = lineItems
    .flatMap((li) => (li.tracking_urls as string[]) ?? [])
    .filter(Boolean)

  return {
    id: String(payload.id ?? ''),
    status: status?.name ?? 'UNKNOWN',
    lineItemStatus: lineItemStatus ?? null,
    message: status?.message ?? null,
    trackingUrls,
  }
}

/** Lulu reports a refused file through the line item, not the job status. */
export function isRejected(job: PrintJob): boolean {
  return job.status === 'REJECTED' || job.lineItemStatus === 'REJECTED'
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
    async quote(item, address) {
      const body = (await call('/print-job-cost-calculations/', {
        method: 'POST',
        body: JSON.stringify({
          line_items: [
            {
              page_count: item.pageCount,
              pod_package_id: item.packageId || LULU_PACKAGE_ID,
              quantity: item.quantity,
            },
          ],
          shipping_address: addressPayload(address),
          shipping_option: SHIPPING_LEVEL,
        }),
      })) as Record<string, unknown>

      const total = body.total_cost_incl_tax ?? body.total_cost_excl_tax
      const shipping = (body.shipping_cost as Record<string, unknown> | undefined)?.total_cost_incl_tax
      const print = (body.line_item_costs as Array<Record<string, unknown>> | undefined)?.[0]
        ?.total_cost_incl_tax

      const cents = (v: unknown): number | null =>
        v === null || v === undefined ? null : Math.round(Number(v) * 100)

      return {
        totalCents: cents(total) ?? 0,
        currency: String(body.currency ?? 'USD'),
        shippingCents: cents(shipping),
        printCents: cents(print),
      }
    },

    async createPrintJob({ item, address, externalId, idempotencyKey }) {
      const body = (await call('/print-jobs/', {
        method: 'POST',
        headers: {
          // Belt to the database's braces: even if press_claim_order were
          // somehow bypassed, Lulu should collapse the duplicate itself.
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          external_id: externalId,
          line_items: [
            {
              title: item.title,
              cover_source_url: item.coverUrl,
              interior_source_url: item.interiorUrl,
              pod_package_id: item.packageId || LULU_PACKAGE_ID,
              page_count: item.pageCount,
              quantity: item.quantity,
            },
          ],
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
