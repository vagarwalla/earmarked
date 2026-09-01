/**
 * press — what a bundle costs, and what it saves.
 *
 * `performBundledApproval` places a bundle; this is the half that has to run
 * *before* anything is placed, because the entire argument for bundling is a
 * number the reader has to be shown while it is still a choice: two issues in
 * one job pay for one parcel, and two jobs pay for two.
 *
 * So a bundled quote alone is not enough. "$22.72" answers nothing on its own
 * — the question is $22.72 against what — and the comparison cannot be derived
 * from the bundled quote, because shipping is not per-book and does not scale.
 * Lulu is therefore asked twice over: once for the job as it would actually be
 * placed, and once per issue for the job it would have been on its own.
 *
 * That is N+1 calls to price N issues, which is worth it exactly here:
 * `/print-job-cost-calculations/` costs nothing and creates nothing, and this
 * is the one screen where the saving is the decision.
 */

import type { LuluClient, QuoteLine, ShippingAddress } from './lulu'
import { allocateQuote, type PrintQuote } from './types'

export interface BundleQuote {
  /** The job as it would be placed: every issue, one parcel. */
  quote: PrintQuote | null
  /** Why there is no quote. A warning, never a blocker — see the note below. */
  quoteError: string | null
  /**
   * Each issue's share of the bundled job — its own print cost plus an equal
   * share of the parcel, which is what the order rows will record.
   */
  perIssueCents: number[] | null
  /** The same issues as one job each. The number bundling is measured against. */
  separateTotalCents: number | null
  /**
   * separateTotal − bundled total. Positive is money not spent.
   *
   * Null rather than zero where either side could not be priced: zero is a
   * claim that bundling saved nothing, and "we could not work it out" is not
   * that claim.
   */
  savingCents: number | null
}

/**
 * Price a bundle, and price the alternative to it.
 *
 * A quote that fails is reported and not thrown. Lulu being briefly
 * unreachable is not a reason an issue cannot be printed — the approval email
 * quotes it again, and the job itself is priced once more at the moment it is
 * placed — so a dead quote leaves the dialog saying so rather than refusing.
 *
 * The per-issue quotes are weaker still: they exist only to compute a saving,
 * and losing them costs a line of copy. One that fails takes the saving with
 * it and leaves the bundled quote — the number that is actually about to be
 * charged — standing.
 */
export async function quoteBundle(
  lines: QuoteLine[],
  address: ShippingAddress,
  lulu: LuluClient,
): Promise<BundleQuote> {
  if (lines.length === 0) {
    return { quote: null, quoteError: null, perIssueCents: null, separateTotalCents: null, savingCents: null }
  }

  // Asked for together, because they are one screen's worth of latency and
  // the reader is waiting on all of them. A bundle of one skips the
  // comparison entirely: there is no second parcel to not pay for, and
  // quoting the same job twice to prove a saving of zero is a round trip
  // spent to render nothing.
  const [bundled, ...separate] = await Promise.allSettled([
    lulu.quote(lines, address),
    ...(lines.length > 1 ? lines.map((line) => lulu.quote(line, address)) : []),
  ])

  if (bundled.status === 'rejected') {
    return {
      quote: null,
      quoteError: (bundled.reason as Error).message,
      perIssueCents: null,
      separateTotalCents: null,
      savingCents: null,
    }
  }

  const quote = bundled.value
  const perIssueCents = allocateQuote(quote, lines.length)

  // Every issue or none. A total missing one issue's job is not "the cost of
  // ordering these separately" — it is a smaller number that would advertise
  // a saving larger than the real one.
  const separateTotalCents =
    separate.length > 0 && separate.every((r) => r.status === 'fulfilled')
      ? separate.reduce((sum, r) => sum + (r as PromiseFulfilledResult<PrintQuote>).value.totalCents, 0)
      : null

  return {
    quote,
    quoteError: null,
    perIssueCents,
    separateTotalCents,
    savingCents: separateTotalCents === null ? null : separateTotalCents - quote.totalCents,
  }
}
