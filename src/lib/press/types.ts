/**
 * press — shared types and the print spec.
 *
 * This module is the contract between the ingestion, extraction, layout,
 * compose, ordering and archival units. It holds no IO.
 *
 * See docs/plans/2026-08-27-001-feat-press-magazine-pipeline-plan.md.
 */

// ── Print spec (KTD1) ────────────────────────────────────────────────────────
// Lulu 7×10 "Executive", perfect bound, standard colour on 60# uncoated,
// glossy cover. Trim price is identical to 8.5×11 at both colour tiers, so 7×10
// wins on weight and on looking like a magazine.
//
// The stock was 80# coated until 2026-09-01. Uncoated is $0.83 cheaper on a
// 106-page issue at the same 444 ppi — so the spine arithmetic below is
// unaffected — and press prints long-form essays with few photographs, which
// is the reading uncoated stock is better at anyway. Coated is still one
// settings field away (`lulu_package_id`) if an issue ever turns photographic.

export const PT_PER_INCH = 72

/** Lulu package id observed on the live calculator, 2026-08-27. Verify against the API package list (U6). */
export const LULU_PACKAGE_ID = '0700X1000.FC.STD.PB.060UW444.GXX'

export const PRINT_SPEC = {
  trimWidthIn: 7,
  trimHeightIn: 10,
  /** Lulu asks for 0.125" bleed on every interior edge. */
  bleedIn: 0.125,
  /** Perfect binding needs at least 32 pages; Lulu caps colour interiors at 800. */
  minPages: 32,
  maxPages: 800,
  /**
   * Pages per inch of the stock in `LULU_PACKAGE_ID` — drives spine width.
   * Still 444 after the 2026-09-01 move from 80# coated to 60# uncoated (see
   * the note above the spec), which is why that change needed no arithmetic
   * here; it is a property of the paper, so it moves with the package id.
   */
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

/**
 * What a Lulu POD package id actually specifies.
 *
 * `0700X1000.FC.STD.PB.060UW444.GXX` is six dot-separated fields: trim, colour,
 * colour quality, binding, paper stock, cover finish. It is the single most
 * consequential string in press — it decides the size, the paper and the price
 * — and it is unreadable, so the review page decodes it rather than carrying a
 * prose description that can drift out of step with the id actually in use.
 *
 * Unknown codes are returned verbatim instead of guessed: a wrong confident
 * answer about what is being printed is worse than an unfamiliar code.
 */
export interface PackageSpec {
  trim: string
  colour: string
  quality: string
  binding: string
  paper: string
  coverFinish: string
  raw: string
}

const BINDINGS: Record<string, string> = {
  PB: 'Perfect bound',
  CO: 'Coil bound',
  CW: 'Wire-o bound',
  SS: 'Saddle stitched',
  LW: 'Linen wrap hardcover',
  CA: 'Case wrap hardcover',
}
const COLOURS: Record<string, string> = { FC: 'Full colour', BW: 'Black and white' }
const QUALITY: Record<string, string> = { STD: 'Standard', PRE: 'Premium' }
const FINISHES: Record<string, string> = { GXX: 'Gloss laminate', MXX: 'Matte laminate' }

/** e.g. "080CW444" -> "80# coated white (444 ppi)". */
function describePaper(code: string): string {
  const m = /^(\d{3})(CW|UW|CC)(\d{3})$/.exec(code)
  if (!m) return code
  const stock = { CW: 'coated white', UW: 'uncoated white', CC: 'coated cream' }[m[2]] ?? m[2]
  return `${Number.parseInt(m[1], 10)}# ${stock} (${Number.parseInt(m[3], 10)} ppi)`
}

/** e.g. "0700X1000" -> "7 × 10 in". */
function describeTrim(code: string): string {
  const m = /^(\d{4})X(\d{4})$/.exec(code)
  if (!m) return code
  const inches = (n: string) => String(Number.parseInt(n, 10) / 100).replace(/\.0+$/, '')
  return `${inches(m[1])} × ${inches(m[2])} in`
}

export function describePackage(packageId: string = LULU_PACKAGE_ID): PackageSpec {
  const [trim, colour, quality, binding, paper, finish] = packageId.split('.')
  return {
    trim: trim ? describeTrim(trim) : packageId,
    colour: COLOURS[colour] ?? colour ?? '—',
    quality: QUALITY[quality] ?? quality ?? '—',
    binding: BINDINGS[binding] ?? binding ?? '—',
    paper: paper ? describePaper(paper) : '—',
    coverFinish: FINISHES[finish] ?? finish ?? '—',
    raw: packageId,
  }
}

// ── Items ────────────────────────────────────────────────────────────────────

/**
 * How an article got here.
 *
 * `paste` is the only one that does not need a credential of V's, and is
 * therefore the whole ingestion story for everybody else (019).
 */
export type ItemSource = 'raindrop' | 'email_link' | 'newsletter' | 'pdf' | 'x' | 'paste'

export type ItemState =
  | 'queued'
  | 'extracted'
  | 'laid_out'
  | 'in_issue'
  | 'printed'
  | 'failed'
  /** Deliberately excluded — a reference page, not reading. Reason recorded. */
  | 'skipped'
  /**
   * Deleted from the pool on purpose (013). The row survives as a tombstone so
   * `url_key`'s unique index makes the deletion stick: re-saving the same link
   * dedupes against it rather than resurrecting it. The raindrop itself lives
   * on in a "Not printing" collection, which is the undo.
   */
  | 'dropped'

export interface PressItem {
  id: string
  /** Whose reading this is — press_accounts.id. See migration 018. */
  owner_id: string
  url: string | null
  url_key: string | null
  source: ItemSource
  raindrop_id: string | null
  state: ItemState
  issue_id: string | null
  /**
   * Running order within `issue_id`, 0-based (migration 010). NULL means the
   * issue has never been reordered by hand, and readers fall back to
   * chronological — so an un-edited issue prints exactly as it always did.
   */
  position: number | null
  title: string | null
  byline: string | null
  source_name: string | null
  published_at: string | null
  content_path: string | null
  fragment_path: string | null
  page_count: number | null
  failure_reason: string | null
  raw_email_path: string | null
  /** This item is a linkpost: it exists to point at the items below it (migration 014). */
  is_linkpost: boolean
  /** The linkpost that named this item, when one did. */
  linkpost_parent_id: string | null
  /** The words that linkpost pointed with. */
  linkpost_anchor: string | null
  /**
   * When this item was last examined for linkposting. Distinct from
   * `is_linkpost = false`, which is an answer; NULL is "never asked", and is
   * what the backfill walks.
   */
  linkpost_scanned_at: string | null
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
  /** Whose press this is — press_accounts.id. Issue numbers count within it. */
  owner_id: string
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
  /** press_items.id in the order the stored PDFs were rendered from; null = never built. */
  built_order: string[] | null
  /** 'shared' means anyone with the link can read it at /press/i/<handle>/<n>. */
  visibility: 'private' | 'shared'
  shared_at: string | null
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
  laid_out: ['in_issue', 'failed', 'skipped', 'dropped'],
  // An issue that is skipped puts its items back to laid_out (see press_skip_issue).
  in_issue: ['printed', 'laid_out', 'failed'],
  printed: [],
  // A failure can be retried from the top.
  failed: ['queued'],
  // Un-skipping returns a reference page to the pool; the call was always V's.
  skipped: ['laid_out', 'dropped'],
  // Permanent. Recovery is the raindrop in "Not printing", not this row.
  dropped: [],
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

/**
 * What was done to an article that did not arrive in English. Recorded on the
 * article rather than inferred at print time, because by then the only
 * evidence left is that the text reads as English.
 */
export interface TranslationProvenance {
  /** English name of the language translated from, e.g. "Russian". */
  sourceLanguage: string
  model: string
  /** ISO-8601, UTC. */
  translatedAt: string
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

/**
 * How a linkpost points. A `pointer` is a crosspost — it exists to send you to
 * one piece. A `roundup` names several. They print the same way; the word is
 * kept because it is what the marker on the page should say.
 */
export type LinkpostKind = 'roundup' | 'pointer'

/** One piece a linkpost sends the reader to. */
export interface LinkpostTarget {
  url: string
  /** The words the linkpost pointed with — the label, when nothing better exists. */
  anchor: string
  /** What the linkpost says it is, in a few words. Null when nothing was said. */
  note: string | null
}

/** Set on a linkpost itself: what it is, and what it named. */
export interface LinkpostMarker {
  kind: LinkpostKind
  /** One line, printed nowhere; kept for the event log and the CLI. */
  reason: string
  targets: LinkpostTarget[]
}

/** Set on a piece that reached the issue because a linkpost pointed at it. */
export interface LinkpostOrigin {
  /** Title of the linkpost that named it. */
  title: string
  /** Canonical URL of that linkpost, for the source line. */
  url: string | null
  /** The words it pointed with. */
  anchor: string | null
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
  /**
   * Present when this piece is a linkpost. Optional for the same reason the
   * footnotes are: extractions stored before linkposts existed must keep
   * loading. See src/lib/press/linkpost.ts.
   */
  linkpost?: LinkpostMarker
  /** Present when a linkpost is why this piece is in the issue. */
  linkpostOf?: LinkpostOrigin
  /**
   * Present when this piece was not written in English. Optional for the same
   * reason the footnotes are: extractions stored before translation existed
   * must keep loading.
   */
  translation?: TranslationProvenance
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
  /** This entry is a linkpost; the entries under it are what it named. */
  isLinkpost?: boolean
  /** Title of the linkpost that brought this entry into the issue. */
  linkpostOf?: string | null
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

/**
 * Whether an issue's running order is the one its PDFs were rendered from.
 *
 * Sequence, not membership: reordering two articles changes the page numbers
 * on the contents page, so a permutation is every bit as stale as an addition.
 * This is the comparison behind `dirty` in both readers and the workbench, and
 * it lives here — beside `tocMeta`, for the same reason — so the three of them
 * cannot answer it differently.
 */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

// ── Ordering (U6) ────────────────────────────────────────────────────────────

export interface PrintQuote {
  totalCents: number
  currency: string
  shippingCents: number | null
  /** Print cost of the whole job — every line item summed. */
  printCents: number | null
  /**
   * Print cost per line item, in the order the lines were quoted.
   *
   * One line is the overwhelmingly common case and `printCents` answers it.
   * A bundle needs this: the issues in it are separate rows in `press_orders`
   * and each has to record what *it* cost, which cannot be recovered from a
   * single total once the job is placed.
   */
  lineCents: (number | null)[]
}

/**
 * Split a bundle's cost back out over its line items.
 *
 * Print cost is Lulu's own per-line number. Shipping is not attributable — one
 * parcel carries the whole bundle, and that is the entire reason for bundling
 * — so it is divided evenly, with the remainder going to the earliest lines so
 * the parts sum to the total exactly rather than to a cent less.
 */
export function allocateQuote(quote: PrintQuote, lines: number): number[] {
  if (lines <= 0) return []
  const shipping = quote.shippingCents ?? 0
  const share = Math.floor(shipping / lines)
  const remainder = shipping - share * lines

  const print = Array.from({ length: lines }, (_, i) => quote.lineCents[i] ?? null)
  const known = print.reduce<number>((a, c) => a + (c ?? 0), 0)

  return print.map((cents, i) => {
    // A line Lulu did not price still owes its share of the parcel. Falling
    // back to an even split of whatever print cost is unaccounted for beats
    // recording zero, which would read as "this issue was free".
    const base = cents ?? Math.max(0, ((quote.printCents ?? known) - known)) / lines
    return Math.round(base) + share + (i < remainder ? 1 : 0)
  })
}

export type ActionKind = 'approve' | 'skip' | 'drop' | 'preview'

export interface ActionToken {
  token_hash: string
  /** The issue this link is about; for a bundle, the first of them. */
  issue_id: string
  /**
   * Every issue the link acts on, `issue_id` included.
   *
   * A bundle is approved by ONE link covering several issues, and a token that
   * could only name one of them would either need a link per issue — several
   * chances to buy half a parcel — or would leave the rest unrecorded. Expiry
   * matches on this array, so re-composing any member invalidates the link.
   */
  issue_ids: string[]
  action: ActionKind
  item_id: string | null
  expires_at: string
  used_at: string | null
  created_at: string
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export type JobState = 'queued' | 'running' | 'done' | 'failed'
/** `rebuild` re-renders a draft; `lock` renders and then freezes it. */
export type JobIntent = 'rebuild' | 'lock'

/** What a finished compose hands back — the same three facts a build streamed. */
export interface JobResult {
  name: string
  pageCount: number
  preflight: { code: string; detail: string }[]
  /** Articles the compose could not read, and why. Empty is the normal case. */
  skipped?: { title: string; reason: string }[]
}

/**
 * One request to render an issue on a machine that has a browser.
 *
 * See supabase/migrations/017_press_jobs.sql for why this is a table rather
 * than a streamed request: a render that outlives the tab that asked for it
 * cannot report through the response body it no longer has.
 */
export interface PressJob {
  id: string
  owner_id: string
  kind: 'compose'
  issue_id: string
  intent: JobIntent
  state: JobState
  progress: string | null
  error: string | null
  result: JobResult | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  heartbeat_at: string | null
}
