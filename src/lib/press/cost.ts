/**
 * press — what a layout costs, near enough to choose by.
 *
 * Lulu's own quote is the authority and the order dialog uses it. This is the
 * other question: not "what will this parcel cost" but "what would a different
 * arrangement of the same articles cost", asked while rearranging them, when
 * there is no parcel yet and a network round trip per candidate layout would
 * make the answer arrive too late to use.
 *
 * The shape is simple enough to carry in two constants, and it is the shape
 * that matters — pages are nearly free and books are not:
 *
 *   every book costs a fixed amount, whatever is in it (cover, binding, setup)
 *   every page costs a few cents, wherever it sits
 *   every parcel costs a base, plus a little for each book in it
 *
 * So splitting one issue into two costs a whole extra book; moving fifty pages
 * from one issue to another costs nothing at all.
 *
 * Fitted to real quotes taken 2026-09-05 — 7×10 full colour, 80# coated, MAIL
 * to California, the package this press actually prints. Straight lines
 * through eight probes from 32 to 300 pages, accurate to about a cent. They
 * will drift as Lulu reprices; they are for choosing a layout, never for
 * telling anyone what they are about to be charged.
 */

/** Per book, whatever is in it. */
export const BOOK_FIXED_CENTS = 235
/** Per interior page. */
export const PAGE_CENTS = 6.1
/** Per parcel, before the books in it. */
export const PARCEL_BASE_CENTS = 491
/** Added to the parcel for each book it carries. */
export const PARCEL_PER_BOOK_CENTS = 78

export interface CostEstimate {
  books: number
  pages: number
  printCents: number
  shippingCents: number
  totalCents: number
}

/**
 * What one parcel holding these books would cost.
 *
 * Takes printed page counts — what the PDF has, front matter included — not
 * the article pages the balance is computed in.
 */
export function estimateCost(pageCounts: number[]): CostEstimate {
  const books = pageCounts.length
  const pages = pageCounts.reduce((n, p) => n + p, 0)
  if (books === 0) {
    return { books: 0, pages: 0, printCents: 0, shippingCents: 0, totalCents: 0 }
  }
  const printCents = Math.round(books * BOOK_FIXED_CENTS + pages * PAGE_CENTS)
  const shippingCents = Math.round(PARCEL_BASE_CENTS + books * PARCEL_PER_BOOK_CENTS)
  return { books, pages, printCents, shippingCents, totalCents: printCents + shippingCents }
}

/** `$98.04`, for a console and for a panel. */
export function money(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}${currency === 'USD' ? '$' : ''}${(Math.abs(cents) / 100).toFixed(2)}`
}

/** The one line that says where the money goes. */
export function costSummary(estimate: CostEstimate): string {
  return (
    `${estimate.books} books, ${estimate.pages}pp — ` +
    `print ${money(estimate.printCents)} + parcel ${money(estimate.shippingCents)} = ` +
    `${money(estimate.totalCents)}`
  )
}
