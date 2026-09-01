/**
 * press — what the physical object actually is.
 *
 * Everything here is read from the configuration that gets sent to Lulu rather
 * than written out by hand: the trim, paper and binding are decoded from the
 * POD package id in use, and the spine is computed from this issue's real page
 * count. So if the package id changes, this changes with it — a printed spec
 * that can quietly disagree with what is being printed would be worse than
 * showing nothing.
 */

import {
  PRINT_SPEC,
  PT_PER_INCH,
  describePackage,
  spineTakesText,
  spineWidthPt,
} from '@/lib/press/types'

const inches = (pt: number) => `${(pt / PT_PER_INCH).toFixed(2)} in`

export function PrintSpec({
  packageId,
  pageCount,
  estimated = false,
}: {
  packageId: string
  pageCount: number
  /** The count is the draft's articles, not a rendered PDF — say so. */
  estimated?: boolean
}) {
  const spec = describePackage(packageId)
  const spine = pageCount > 0 ? spineWidthPt(pageCount) : null

  const rows: [string, string][] = [
    ['Trim', spec.trim],
    ['Binding', spec.binding],
    ['Interior', `${spec.colour} · ${spec.quality} · ${spec.paper}`],
    ['Cover', `${spec.coverFinish}, printed as one spread`],
    ['Bleed', `${PRINT_SPEC.bleedIn} in on every edge`],
    [
      'Spine',
      spine === null
        ? '—'
        : `${inches(spine)} at ${estimated ? 'about ' : ''}${pageCount} pages` +
          (spineTakesText(pageCount)
            ? ' · wide enough for spine text'
            : ` · too narrow for text under ${PRINT_SPEC.minPagesForSpineText} pages`),
    ],
    ['Page limits', `${PRINT_SPEC.minPages}–${PRINT_SPEC.maxPages}, always an even count`],
  ]

  return (
    <details className="mt-4 rounded-lg border px-4 py-3">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
        Print specification
      </summary>
      <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground mt-3 font-mono text-[0.65rem] break-all">{spec.raw}</p>
    </details>
  )
}
