'use client'

/**
 * Inline PDF preview. Rendered by the browser's own viewer through an
 * <object>, so there is no PDF library to ship; the fallback matters because
 * some browsers refuse to embed PDFs at all.
 *
 * It used to open collapsed, on the reasoning that a viewer would push the
 * contents list below the fold. It did worse than that — the component was
 * left out of the workbench entirely and the preview quietly disappeared. So
 * now it is the top half of the issue and the list is the bottom half, both on
 * screen at once.
 *
 * Which sheet is shown, and whether it is shown at all, is decided in the
 * right-hand column: this is the page, and the controls that act on it live
 * with every other control. That keeps the middle column to two things — the
 * pages and the running order — and gives the viewer the height the row of
 * buttons above it used to take.
 */

const FILES: Record<Sheet, string> = { interior: 'interior.pdf', cover: 'cover.pdf' }

export type Sheet = 'interior' | 'cover'

export function IssuePreview({
  issueNumber,
  version,
  sheet,
  built,
}: {
  issueNumber: number
  /** When the file was last written. Changing it is what reloads the viewer. */
  version: string | null
  sheet: Sheet
  /** Whether there is a PDF at all. When there is not, this says so instead. */
  built: boolean
}) {
  // A rebuild replaces the PDF at the same URL, and neither the embedded
  // viewer nor the browser cache would notice on their own.
  const src = `/api/press/file/${issueNumber}/${FILES[sheet]}?v=${encodeURIComponent(version ?? '')}`

  if (!built) {
    return (
      <div className="text-muted-foreground flex h-full min-h-[8rem] flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm">
        No PDF yet. <span className="font-medium">Rebuild</span> — or lock — to see this issue.
      </div>
    )
  }

  return (
    <object
      // Keyed so switching sheets swaps the embed rather than asking the
      // plugin to re-resolve its own data attribute, which Safari ignores.
      key={sheet}
      data={src}
      type="application/pdf"
      className="h-[46vh] w-full rounded-lg border lg:h-full"
    >
      <p className="p-6 text-sm">
        Your browser will not embed the PDF.{' '}
        <a href={src} target="_blank" rel="noreferrer" className="underline">
          Open it in a new tab
        </a>
        .
      </p>
    </object>
  )
}
