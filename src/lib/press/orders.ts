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
import { createLuluClient, isShipped, lineFor, type LuluClient, type ShippingAddress } from './lulu'
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
  /** The Lulu job this row went to. Shared with the other issues bundled into it. */
  bundle_key: string | null
  /** Which line of that job this issue is. */
  line_index: number
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

/**
 * Let go of a row that is holding an issue hostage.
 *
 * `placeOrder` claims the row before Lulu is called, so a job Lulu refuses
 * outright leaves a `pending` row with no job id. `openOrder` counts that as
 * an order in progress, so the issue could never be ordered again — the reader
 * fixes whatever Lulu objected to and the workbench still says "an order for
 * this issue is already in progress", for ever.
 *
 * The `is('lulu_job_id', null)` is the whole safety of this. A row that names
 * a job is a real order at Lulu whatever our column says, and releasing it
 * would let a second one be placed for the same issue. The filter is in the
 * query rather than in a check above it so that a row which acquires a job id
 * between the read and the write is not released either.
 */
export async function releaseOrder(orderId: string, db: SupabaseClient = pressDb()): Promise<boolean> {
  const { data, error } = await db
    .from('press_orders')
    .update({ status: 'REJECTED', message: 'Released: Lulu never accepted this job.' })
    .eq('id', orderId)
    .is('lulu_job_id', null)
    .neq('status', 'REJECTED')
    .select('id, issue_id')
  if (error) throw new Error(error.message)
  const released = (data ?? [])[0]
  if (!released) return false

  // Claiming the row also moves the issue to `approved`, which is not one of
  // the states that can be ordered — so releasing the row alone left the issue
  // with no order in progress and no Order button either, which is a second
  // dead end rather than a fix.
  //
  // Only ever `approved`. `ordered` and `shipped` mean a job exists at Lulu,
  // and winding those back would offer to buy a book that is already printing.
  const { data: issue } = await db
    .from('press_issues')
    .select('id, state')
    .eq('id', released.issue_id)
    .maybeSingle()

  if (issue?.state === 'approved') {
    const { data: live } = await db
      .from('press_orders')
      .select('id')
      .eq('issue_id', released.issue_id)
      .not('lulu_job_id', 'is', null)
      .limit(1)

    // A sibling row that DID reach Lulu keeps the issue where it is.
    if (!(live ?? []).length) {
      await db
        .from('press_issues')
        .update({ state: 'closed', ordered_at: null, lulu_job_id: null })
        .eq('id', released.issue_id)
        .eq('state', 'approved')
    }
  }

  await recordEvent(
    { issue_id: released.issue_id, kind: 'order_failed', detail: { orderId, reason: 'released by hand' } },
    db,
  )
  return true
}

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
    /** The job this issue is going into; shared by every issue in a bundle. */
    bundleKey?: string | null
    /** Which line of that job. Zero for a job carrying one issue. */
    lineIndex?: number
  },
  db: SupabaseClient = pressDb(),
): Promise<PressOrder> {
  const { data, error } = await db.rpc('press_place_order', {
    p_issue_id: opts.issueId,
    p_idempotency_key: opts.idempotencyKey,
    p_quantity: opts.quantity,
    p_ship_to: opts.shipTo,
    p_ordered_by: opts.orderedBy,
    p_bundle_key: opts.bundleKey ?? null,
    p_line_index: opts.lineIndex ?? 0,
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

/** The other issues that went to Lulu in the same job as this one. */
export async function ordersForBundle(
  bundleKey: string,
  db: SupabaseClient = pressDb(),
): Promise<PressOrder[]> {
  const { data, error } = await db
    .from('press_orders')
    .select('*')
    .eq('bundle_key', bundleKey)
    .order('line_index', { ascending: true })
  if (error) throw new Error(`press/orders: forBundle: ${error.message}`)
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

  // One GET per JOB, not per order. A bundle's issues share a job id, and
  // asking Lulu the same question once per issue would be three round trips
  // for one answer — and three chances for one of them to fail and report the
  // bundle as half-broken.
  const jobs = new Map<string, Awaited<ReturnType<LuluClient['getPrintJob']>>>()

  for (const order of open) {
    try {
      const jobId = order.lulu_job_id as string
      let job = jobs.get(jobId)
      if (!job) {
        job = await client.getPrintJob(jobId)
        jobs.set(jobId, job)
      }

      // The line that is THIS issue. In a bundle the job-level status covers
      // the parcel and says nothing about which interior Lulu refused, so the
      // per-line status is the only one that belongs on this row.
      const line = lineFor(job, order.idempotency_key, order.line_index ?? 0)
      const lineRejected = line?.status === 'REJECTED'

      await updateOrder(
        order.id,
        {
          status: job.status,
          line_item_status: line?.status ?? job.lineItemStatus,
          message: line?.message ?? job.message,
          // A bundle ships as one parcel, so the job's tracking is this
          // issue's tracking; a line that carries its own wins where it does.
          tracking_urls: line?.trackingUrls.length ? line.trackingUrls : job.trackingUrls,
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
        // Only THIS issue's line failing makes THIS issue rejected. A bundle
        // where Lulu refuses issue 4's interior must not drag issue 3 —
        // printing perfectly well on the next line of the same job — into
        // 'rejected' alongside it. Where the job itself is rejected, so is
        // every line of it, and this is true for all of them.
        if (lineRejected || job.status === 'REJECTED') {
          await db
            .from('press_issues')
            .update({
              state: 'rejected',
              rejection_reason: line?.message ?? job.message,
              lulu_status: job.status,
            })
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

/** The orders that went to Lulu in one job, and what that job cost. */
export interface OrderGroup {
  /** Stable list key: the bundle's key, or the row's own id where it has none. */
  key: string
  bundleKey: string | null
  orders: OrderWithIssue[]
  /** Every row's share summed — the job's cost, which is what was charged. */
  totalCents: number | null
  currency: string | null
}

/**
 * Gather the rows that share a Lulu job.
 *
 * An order stays one row per issue, because everything downstream of it is per
 * issue — but the *charge* is per job, and a panel that only ever showed rows
 * would report a bundle as two orders of about half the price each and leave
 * the reader to guess that one parcel is coming. The grouping is presentation
 * over the same rows, not a second source of truth.
 *
 * A row with no bundle key is its own group: that is every order placed before
 * bundling existed, and it is exactly what it looks like — one issue, one job.
 * First-appearance order is preserved, so the panel stays newest-first.
 */
export function groupByBundle(orders: OrderWithIssue[]): OrderGroup[] {
  const groups: OrderGroup[] = []
  const byKey = new Map<string, OrderGroup>()

  for (const order of orders) {
    const existing = order.bundle_key ? byKey.get(order.bundle_key) : undefined
    if (existing) {
      existing.orders.push(order)
      continue
    }
    const group: OrderGroup = {
      key: order.bundle_key ?? order.id,
      bundleKey: order.bundle_key,
      orders: [order],
      totalCents: null,
      currency: null,
    }
    if (order.bundle_key) byKey.set(order.bundle_key, group)
    groups.push(group)
  }

  for (const group of groups) {
    const known = group.orders.filter((o) => o.cost_cents !== null)
    // Null rather than zero where nothing was priced: zero reads as free.
    group.totalCents = known.length ? known.reduce((n, o) => n + (o.cost_cents as number), 0) : null
    group.currency = group.orders.find((o) => o.currency)?.currency ?? null
  }
  return groups
}

/** Money, the way the panel and the dialog both want it. */
export function formatMoney(cents: number | null, currency: string | null): string {
  if (cents === null) return '—'
  return `${(cents / 100).toFixed(2)} ${currency ?? 'USD'}`
}
