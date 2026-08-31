'use client'

/**
 * Inline PDF preview. Rendered by the browser's own viewer through an
 * <object>, so there is no PDF library to ship; the fallback matters because
 * some browsers refuse to embed PDFs at all.
 */

import { useState } from 'react'

export function IssuePreview({ issueNumber }: { issueNumber: number }) {
  // Collapsed by default: the contents list is what gets reviewed, and a
  // full-height PDF viewer would push it below the fold on every visit.
  const [open, setOpen] = useState(false)
  const src = `/api/press/file/${issueNumber}/interior.pdf`

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground mb-2 text-xs underline"
      >
        {open ? 'Hide preview' : 'Preview the issue'}
      </button>
      {open && (
        <object data={src} type="application/pdf" className="h-[70vh] w-full rounded-lg border">
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
