/**
 * press — shared types and the print spec.
 *
 * This module is the contract between the ingestion, extraction, layout,
 * compose, ordering and archival units. It holds no IO.
 *
 * See docs/plans/2026-08-27-001-feat-press-magazine-pipeline-plan.md.
 */

// ── Print spec (KTD1) ────────────────────────────────────────────────────────
// Lulu 7×10 "Executive", perfect bound, standard colour on 80# coated, glossy
// cover. Trim price is identical to 8.5×11 at both colour tiers, so 7×10 wins
// on weight and on looking like a magazine.

export const PT_PER_INCH = 72

/** Lulu package id observed on the live calculator, 2026-08-27. Verify against the API package list (U6). */
export const LULU_PACKAGE_ID = '0700X1000.FC.STD.PB.080CW444.GXX'

export const PRINT_SPEC = {
  trimWidthIn: 7,
  trimHeightIn: 10,
  /** Lulu asks for 0.125" bleed on every interior edge. */
  bleedIn: 0.125,
  /** Perfect binding needs at least 32 pages; Lulu caps colour interiors at 800. */
  minPages: 32,
  maxPages: 800,
  /** Pages per inch for 80# coated stock — drives spine width. */
  pagesPerInch: 444,
  /**
   * Constant Lulu adds to every softcover perfect-bound spine, on top of the
   * paper stack itself: the glue and the fold of the wrap.
   * `(pages / 444) + 0.06" = spine width` — help.api.lulu.com, "How is spine
   * width calculated?". Leaving it out makes the spread 0.06" narrow, which
   * walks the front panel half that distance off the fold.
   */
  spineWrapIn: 0.06,
  /**
   * Below this, Lulu says not to print spine text at all: the spine is too
   * narrow for the binding tolerance to keep it off the faces.
   */
  minPagesForSpineText: 100,
  /** Clearance Lulu requires between spine text and each edge of the spine. */
  spineTextClearanceIn: 0.0625,
  /** Keep cover content this far inside the trim; the guillotine wanders. */
  coverSafetyIn: 0.5,
} as const

export const TRIM_WIDTH_PT = PRINT_SPEC.trimWidthIn * PT_PER_INCH        // 504
export const TRIM_HEIGHT_PT = PRINT_SPEC.trimHeightIn * PT_PER_INCH      // 720
export const BLEED_PT = PRINT_SPEC.bleedIn * PT_PER_INCH                 // 9
/** Interior media box: trim plus bleed on all four sides. */
export const MEDIA_WIDTH_PT = TRIM_WIDTH_PT + 2 * BLEED_PT               // 522
export const MEDIA_HEIGHT_PT = TRIM_HEIGHT_PT + 2 * BLEED_PT             // 738

/** Spine width in points for a perfect-bound interior of `pages` pages. */
export function spineWidthPt(pages: number): number {
  return (pages / PRINT_SPEC.pagesPerInch + PRINT_SPEC.spineWrapIn) * PT_PER_INCH
}

/**
 * Whether this issue is thick enough to carry spine text. Under Lulu's floor
 * the answer is no and the spine prints bare — the binder's drift would land
 * the words on the front or back panel.
 */
export function spineTakesText(pages: number): boolean {
  return pages >= PRINT_SPEC.minPagesForSpineText
}

/** Type height available on the spine once Lulu's clearance is taken off both edges. */
export function spineTextHeightPt(pages: number): number {
  return spineWidthPt(pages) - 2 * PRINT_SPEC.spineTextClearanceIn * PT_PER_INCH
}

/** Cover safety margin in points — how far in from the trim edge content must stay. */
export const COVER_SAFETY_PT = PRINT_SPEC.coverSafetyIn * PT_PER_INCH    // 36

/**
 * Full cover media box: back + spine + front, plus bleed all round.
 * Lulu wants the cover as one spread.
 */
export function coverSizePt(pages: number): { width: number; height: number } {
  return {
    width: 2 * TRIM_WIDTH_PT + spineWidthPt(pages) + 2 * BLEED_PT,
    height: TRIM_HEIGHT_PT + 2 * BLEED_PT,
  }
}

// ── Items ────────────────────────────────────────────────────────────────────

export type ItemSource = 'raindrop' | 'email_link' | 'newsletter' | 'pdf' | 'x'

export type ItemState = 'queued' | 'extracted' | 'laid_out' | 'in_issue' | 'printed' | 'failed'

export interface PressItem {
  id: string
  url: string | null
  url_key: string | null
  source: ItemSource
  raindrop_id: string | null
  state: ItemState
  issue_id: string | null
  title: string | null
  byline: string | null
  source_name: string | null
  published_at: string | null
  content_path: string | null
  fragment_path: string | null
  page_count: number | null
  failure_reason: string | null
  raw_email_path: string | null
  created_at: string
  updated_at: string
}

/** A new item on its way into the queue. */
export type NewPressItem = Partial<Omit<PressItem, 'id' | 'created_at' | 'updated_at'>> &
  Pick<PressItem, 'source'>

// ── Issues ───────────────────────────────────────────────────────────────────

export type IssueState = 'open' | 'closed' | 'approved' | 'ordered' | 'shipped' | 'skipped' | 'rejected'

export interface PressIssue {
  id: string
  number: number
  state: IssueState
  name: string | null
  page_total: number
  interior_path: string | null
  cover_path: string | null
  quote_cents: number | null
  quote_currency: string | null
  lulu_job_id: string | null
  lulu_idempotency_key: string | null
  lulu_status: string | null
  tracking_url: string | null
  archive_collection_id: string | null
  rejection_reason: string | null
  opened_at: string
  closed_at: string | null
  approved_at: string | null
  ordered_at: string | null
  shipped_at: string | null
  approval_sent_at: string | null
  updated_at: string
}

// ── State machines ───────────────────────────────────────────────────────────
// Kept as data so both the guards and the tests read from one source.

export const ITEM_TRANSITIONS: Record<ItemState, readonly ItemState[]> = {
  queued: ['extracted', 'failed'],
  extracted: ['laid_out', 'failed'],
  laid_out: ['in_issue', 'failed'],
  // An issue that is skipped puts its items back to laid_out (see press_skip_issue).
  in_issue: ['printed', 'laid_out', 'failed'],
  printed: [],
  // A failure can be retried from the top.
  failed: ['queued'],
}

export const ISSUE_TRANSITIONS: Record<IssueState, readonly IssueState[]> = {
  open: ['closed'],
  closed: ['approved', 'skipped'],
  approved: ['ordered', 'rejected'],
  // Lulu refused the files; recompose and re-approve, or give up on the issue.
  rejected: ['approved', 'skipped'],
  ordered: ['shipped'],
  shipped: [],
  skipped: [],
}

export function canTransitionItem(from: ItemState, to: ItemState): boolean {
  return ITEM_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionIssue(from: IssueState, to: IssueState): boolean {
  return ISSUE_TRANSITIONS[from]?.includes(to) ?? false
}

// ── Normalized article (U3 output → U4 input) ────────────────────────────────

export interface ArticleImage {
  /** Path in the `press` Storage bucket. Never a network URL — the renderer must not fetch. */
  path: string
  alt: string | null
  caption: string | null
  width: number | null
  height: number | null
  /** Landscape images wider than the text column get the full page width. */
  orientation: 'portrait' | 'landscape' | 'square'
}

export type ArticleBlock =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'para'; html: string }
  | { type: 'quote'; html: string; attribution?: string }
  | { type: 'figure'; image: ArticleImage }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'rule' }

/**
 * One note from an article's footnote apparatus, lifted out of the body so it
 * can be set as notes rather than as stray paragraphs at the end of the piece.
 */
export interface ArticleFootnote {
  /** As printed in the body's marker, e.g. "1". Kept from the source, not renumbered. */
  marker: string
  /** Sanitised inline HTML of the note itself. */
  html: string
}

export interface Article {
  title: string
  byline: string | null
  /** Publication name, e.g. "The Atlantic". */
  sourceName: string | null
  /** Canonical URL, printed in small type at the article end. */
  url: string | null
  publishedAt: string | null
  /** Standfirst / summary, when the page offers one. */
  dek: string | null
  lead: ArticleImage | null
  blocks: ArticleBlock[]
  /**
   * Optional: extractions stored before footnote support simply do not have
   * the field, and must keep loading rather than fail preflight.
   */
  footnotes?: ArticleFootnote[]
}

// ── Layout (U4) ──────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Printed issue number, for the running footer. */
  issueNumber: number
  /** Page number the first page of this render carries. */
  startPage: number
  /** Measurement renders skip furniture that only makes sense in a real issue. */
  measurement?: boolean
}

export interface RenderResult {
  pdf: Uint8Array
  pageCount: number
}

// ── Compose (U5) ─────────────────────────────────────────────────────────────

export interface TocEntry {
  itemId: string
  title: string
  byline: string | null
  sourceName: string | null
  startPage: number
  pageCount: number
}

/**
 * The byline and the publication are often the same string on a personal blog
 * ("Joe Carlsmith · Joe Carlsmith"), which reads as a mistake on the page.
 *
 * Lives here rather than in compose.ts so the review UI can use it: importing
 * it from compose would pull pdf-lib and the whole render chain into the page.
 */
export function tocMeta(entry: Pick<TocEntry, 'byline' | 'sourceName'>): string {
  const parts = [entry.byline, entry.sourceName].filter((p): p is string => Boolean(p))
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i)
  return unique.join(' · ')
}

export interface ComposedIssue {
  issueId: string
  number: number
  name: string
  interior: Uint8Array
  cover: Uint8Array
  pageCount: number
  toc: TocEntry[]
}

// ── Ordering (U6) ────────────────────────────────────────────────────────────

export interface PrintQuote {
  totalCents: number
  currency: string
  shippingCents: number | null
  printCents: number | null
}

export type ActionKind = 'approve' | 'skip' | 'drop' | 'preview'

export interface ActionToken {
  token_hash: string
  issue_id: string
  action: ActionKind
  item_id: string | null
  expires_at: string
  used_at: string | null
  created_at: string
}
