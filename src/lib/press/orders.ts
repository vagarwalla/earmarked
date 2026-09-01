/**
 * press — orders as rows (U6, plan §7).
 *
 * An order used to be four columns on the issue, which could only ever express
 * one order per issue: `press_claim_order` kept the claim in
 * `press_issues.lulu_job_id`, so a second copy of a shipped issue was not a
 * feature that had not been built, it was a shape the schema forbade.
 *
 * `press_place_order` replaces it and reads the issue's state to decide what
 * kind of order this is — a locked issue is the print run and advances to
 * `approved` in the same statement that claims it, so "an unlocked issue
 * cannot be printed" stays a Postgres guarantee; an already-shipped one is
 * just another copy and leaves the issue's state machine alone.
 *
 * Idempotency lives on `press_orders.idempotency_key`, where it belongs: a
 * retry after a timeout finds the first attempt's row instead of buying a
 * second copy.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { pressDb, recordEvent } from './db'
import { loadEffectiveSettings } from './settings-db'
import { createLuluClient, isRejected, isShipped, type LuluClient, type ShippingAddress } from './lulu'
import type { PressIssue } from './types'

export interface PressOrder {
  id: string
  issue_id: string
  lulu_job_id: string | null
  idempotency_key: string
  status: string
  line_item_status: string | null
  message: string | null
  quantity: number
  cost_cents: number | null
  currency: string | null
  tracking_urls: string[]
  ship_to: ShippingAddress | null
  ordered_by: string | null
  placed_at: string
  shipped_at: string | null
  updated_at: string
}

/** An order with the issue it is for, which is what the panel lists. */
export interface OrderWithIssue extends PressOrder {
  issue_number: number
  issue_name: string | null
}

/**
 * Lulu's own progression, in the order it happens. Used to decide whether an
 * order is still worth polling and to sort the panel's status column.
 */
export const LULU_TERMINAL = ['SHIPPED', 'CANCELED', 'REJECTED'] as const

export function isFinished(order: Pick<PressOrder, 'status' | 'shipped_at'>): boolean {
  return Boolean(order.shipped_at) || (LULU_TERMINAL as readonly string[]).includes(order.status)
}

/**
 * A stable key for one order.
 *
 * The first order of an issue keys on the issue, so a double-tap of the
 * approval link collapses. A reorder cannot — it is deliberately a second
 * purchase of the same issue — so it carries the moment it was asked for.
 */
export function idempotencyKeyFor(issue: PressIssue, reorder: boolean, now = new Date()): string {
  return reorder ? `press-issue-${issue.id}-copy-${now.getTime()}` : `press-issue-${issue.id}`
}

export async function placeOrder(
  opts: {
    issueId: string
    idempotencyKey: string
    quantity: number
    shipTo: ShippingAddress
    orderedBy: string | null
  },
  db: SupabaseClient = pressDb(),
): Promise<PressOrder> {
  const { data, error } = await db.rpc('press_place_order', {
    p_issue_id: opts.issueId,
    p_idempotency_key: opts.idempotencyKey,
    p_quantity: opts.quantity,
    p_ship_to: opts.shipTo,
    p_ordered_by: opts.orderedBy,
  })
  if (error) {
    throw new Error(error.message.replace(/^press_place_order:\s*/, ''))
  }
  return data as PressOrder
}

export async function updateOrder(
  orderId: string,
  patch: Partial<PressOrder>,
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const { error } = await db
    .from('press_orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', orderId)
  if (error) throw new Error(`press/orders: update: ${error.message}`)
}

export async function ordersForIssue(
  issueId: string,
  db: SupabaseClient = pressDb(),
): Promise<PressOrder[]> {
  const { data, error } = await db
    .from('press_orders')
    .select('*')
    .eq('issue_id', issueId)
    .order('placed_at', { ascending: false })
  if (error) throw new Error(`press/orders: forIssue: ${error.message}`)
  return (data as PressOrder[]) ?? []
}

/** Every order, newest first, with the issue it belongs to. */
export async function listOrders(db: SupabaseClient = pressDb()): Promise<OrderWithIssue[]> {
  const { data, error } = await db
    .from('press_orders')
    .select('*, press_issues!inner(number,name)')
    .order('placed_at', { ascending: false })
  if (error) throw new Error(`press/orders: list: ${error.message}`)

  return ((data as (PressOrder & { press_issues: { number: number; name: string | null } })[]) ?? []).map(
    ({ press_issues, ...order }) => ({
      ...order,
      issue_number: press_issues.number,
      issue_name: press_issues.name,
    }),
  )
}

/**
 * Ask Lulu where every unfinished order has got to.
 *
 * A button and a background pass, so the panel is right whether or not the
 * worker is up. One order failing to refresh must not stop the rest: a job id
 * Lulu has forgotten, or a sandbox job after a switch to live, would otherwise
 * freeze the whole panel.
 */
/**
 * Is this order the issue's print run, or an extra copy?
 *
 * The print run is the one whose key the issue recorded when it was claimed.
 * idempotencyKeyFor gives a reorder a distinct, time-stamped key precisely so
 * this question has an answer.
 */
export function isPrintRun(order: Pick<PressOrder, 'idempotency_key' | 'issue_id'> & {
  issue_idempotency_key?: string | null
}): boolean {
  // A reorder's key carries a `-copy-` segment; the print run's never does.
  return !order.idempotency_key.includes('-copy-')
}

export async function refreshOrders(
  db: SupabaseClient = pressDb(),
  lulu?: LuluClient,
): Promise<{ refreshed: number; errors: string[] }> {
  const open = (await listOrders(db)).filter((o) => !isFinished(o) && o.lulu_job_id && o.lulu_job_id !== 'pending')
  if (open.length === 0) return { refreshed: 0, errors: [] }

  // The same settings the order was PLACED with. createLuluClient() alone
  // falls back to the environment, and press_settings.lulu_sandbox is
  // authoritative over it — so an env that says live and a row that says
  // sandbox would place jobs on one host and look for them on the other,
  // 404ing on every poll while the order sat at CREATED forever.
  const client = lulu ?? createLuluClient({ settings: await loadEffectiveSettings(db) })
  const errors: string[] = []
  let refreshed = 0

  for (const order of open) {
    try {
      const job = await client.getPrintJob(order.lulu_job_id as string)
      await updateOrder(
        order.id,
        {
          status: job.status,
          line_item_status: job.lineItemStatus,
          message: job.message,
          tracking_urls: job.trackingUrls,
          ...(isShipped(job) && !order.shipped_at ? { shipped_at: new Date().toISOString() } : {}),
        },
        db,
      )
      // Only the issue's OWN order moves the issue. An extra copy is a
      // separate purchase of something already printed: if Lulu refuses its
      // files, that says nothing about the issue, and letting it flip the
      // issue to `rejected` would both lie in the UI and — because the shipped
      // transition below is gated on state 'ordered' — strand the real print
      // run short of `shipped`, so archiveIssue would never file the raindrops.
      if (isPrintRun(order)) {
        if (isShipped(job)) {
          await db
            .from('press_issues')
            .update({ state: 'shipped', shipped_at: new Date().toISOString(), lulu_status: job.status })
            .eq('id', order.issue_id)
            .eq('state', 'ordered')
        }
        if (isRejected(job)) {
          await db
            .from('press_issues')
            .update({ state: 'rejected', rejection_reason: job.message, lulu_status: job.status })
            .eq('id', order.issue_id)
            .in('state', ['approved', 'ordered'])
        }
      }
      refreshed += 1
    } catch (err) {
      errors.push(`Issue ${order.issue_number}: ${(err as Error).message}`)
    }
  }

  await recordEvent({ kind: 'orders_refreshed', detail: { refreshed, errors: errors.length } }, db)
  return { refreshed, errors }
}

/** Money, the way the panel and the dialog both want it. */
export function formatMoney(cents: number | null, currency: string | null): string {
  if (cents === null) return '—'
  return `${(cents / 100).toFixed(2)} ${currency ?? 'USD'}`
}
