'use client'

/**
 * Inline PDF preview. Rendered by the browser's own viewer through an
 * <object>, so there is no PDF library to ship; the fallback matters because
 * some browsers refuse to embed PDFs at all.
 *
 * The cover is previewed here beside the interior rather than only offered as
 * a download: it is the part of the issue most likely to be wrong and the part
 * a download makes slowest to look at.
 */

import { useState } from 'react'

type Sheet = 'interior' | 'cover'

const SHEETS: { key: Sheet; file: string; label: string; note: string }[] = [
  { key: 'interior', file: 'interior.pdf', label: 'Interior', note: 'Contents and articles' },
  {
    key: 'cover',
    file: 'cover.pdf',
    label: 'Cover',
    // Worth saying: the single landscape page is the whole wrap, not a mistake.
    note: 'One spread — back, spine, front',
  },
]

export function IssuePreview({
  issueNumber,
  version,
  hasCover = true,
}: {
  issueNumber: number
  /** When the file was last written. Changing it is what reloads the viewer. */
  version: string | null
  hasCover?: boolean
}) {
  // Collapsed by default: the contents list is what gets reviewed, and a
  // full-height PDF viewer would push it below the fold on every visit.
  const [open, setOpen] = useState(false)
  const [sheet, setSheet] = useState<Sheet>('interior')

  const sheets = SHEETS.filter((s) => s.key !== 'cover' || hasCover)
  const active = sheets.find((s) => s.key === sheet) ?? sheets[0]
  // A rebuild replaces the PDF at the same URL, and neither the embedded
  // viewer nor the browser cache would notice on their own.
  const src = `/api/press/file/${issueNumber}/${active.file}?v=${encodeURIComponent(version ?? '')}`

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground text-xs underline"
        >
          {open ? 'Hide preview' : 'Preview the issue'}
        </button>

        {open && sheets.length > 1 && (
          <div className="flex gap-1" role="tablist" aria-label="Which PDF to preview">
            {sheets.map((s) => (
              <button
                key={s.key}
                role="tab"
                aria-selected={s.key === active.key}
                onClick={() => setSheet(s.key)}
                className={
                  s.key === active.key
                    ? 'bg-foreground text-background rounded-md px-2.5 py-1 text-xs'
                    : 'text-muted-foreground hover:bg-accent rounded-md border px-2.5 py-1 text-xs'
                }
              >
                {s.label}
              </button>
            ))}
            <span className="text-muted-foreground self-center pl-1 text-xs">{active.note}</span>
          </div>
        )}
      </div>

      {open && (
        <object
          // Keyed so switching sheets swaps the embed rather than asking the
          // plugin to re-resolve its own data attribute, which Safari ignores.
          key={active.key}
          data={src}
          type="application/pdf"
          className="h-[70vh] w-full rounded-lg border"
        >
          <p className="p-6 text-sm">
            Your browser will not embed the PDF.{' '}
            <a href={src} target="_blank" rel="noreferrer" className="underline">
              Open it in a new tab
            </a>
            .
          </p>
        </object>
      )}
    </div>
  )
}
