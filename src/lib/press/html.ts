/**
 * press — escaping, in one place.
 *
 * Three things in press build HTML out of text somebody else wrote: the
 * printed page (`layout/render.ts`), the approval email (`approval.ts`) and
 * the weekly failure digest (`digest.ts`). Every one of them interpolates a
 * title, a byline or a failure reason that arrived through the email door or
 * off a stranger's web page.
 *
 * They each carried their own escape function, and the three had drifted: two
 * left the apostrophe alone, which is safe inside an element and is not safe
 * inside a single-quoted attribute. Rather than keep three near-copies of a
 * security-relevant four-liner, there is one, and it covers both positions.
 *
 * This module deliberately has no imports. `render.ts` reaches for `pdf-lib`
 * and the filesystem, so anything that wanted its `escapeHtml` had to take the
 * renderer with it — which is why the copies existed in the first place.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escape text for both element content and quoted attribute values. */
export function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c])
}
