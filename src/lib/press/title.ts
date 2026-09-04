/**
 * press — tidying an article's title for print.
 *
 * Its own module because two very different places need it and neither should
 * pull in the other: extraction, where a title is first read off a page, and
 * the build, where an article already on disk is laid out. Pure string work,
 * no dependencies.
 *
 * Titles arrive dirty in two ways, and both of them end up on a cover:
 *
 *   - **Markup.** Some extractors hand back the `<h1>`'s inner HTML rather
 *     than its text, so Issue 4's back cover printed the characters
 *     `<em>g</em>, a Statistical Myth`.
 *   - **The publication's own name.** Many sites append it to `<title>`, so
 *     Issue 8's cover carried "Works in Progress Magazine" three times. On a
 *     cover that already says where a piece came from it reads as a mistake.
 *
 * The second is the delicate one: a title may legitimately contain a dash. So
 * the name is only cut when the segment beside the separator actually names
 * the site the article came from — checked against the host, not guessed.
 */

/** Words a publication appends to its own name; not part of the match. */
const PUBLICATION_WORDS = /\b(?:magazine|blog|newsletter|news|substack|online|com)\b/g

/** Separators a site uses to bolt its name onto a title. */
const SEPARATORS = /\s+[-|–—·:]\s+/

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&apos;': "'",
  '&#39;': "'",
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
}

/** Letters only, lowercased — what two names have in common if they are one name. */
function letters(value: string): string {
  return value.toLowerCase().replace(PUBLICATION_WORDS, '').replace(/[^a-z]/g, '')
}

/** The site an article came from, as letters: `worksinprogress.co` → `worksinprogress`. */
function hostLetters(url: string | null | undefined): string {
  if (!url) return ''
  try {
    return letters(new URL(url).hostname.replace(/^www\./i, '').replace(/\.[a-z.]{2,8}$/i, ''))
  } catch {
    return ''
  }
}

/** True when this segment is the publication's name rather than part of the title. */
function namesTheSite(segment: string, host: string, siteName: string | null | undefined): boolean {
  const seg = letters(segment)
  if (seg.length < 3) return false
  if (host && (host === seg || host.startsWith(seg) || seg.startsWith(host))) return true
  const site = letters(siteName ?? '')
  return Boolean(site) && site.length >= 3 && (site === seg || site.startsWith(seg) || seg.startsWith(site))
}

/**
 * A title fit to print: no markup, no entities, and without the publication's
 * name bolted on at either end.
 *
 * `url` and `siteName` are what the site name is checked against; without them
 * only the markup is cleaned, which is the safe half.
 */
export function cleanTitle(
  raw: string | null | undefined,
  siteName?: string | null,
  url?: string | null,
): string {
  let title = String(raw ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)
    .replace(/\s+/g, ' ')
    .trim()

  const host = hostLetters(url)
  if (!host && !siteName) return title

  // At most one cut at each end: a title is not made of publication names.
  const parts = title.split(SEPARATORS)
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]
    if (namesTheSite(last, host, siteName)) {
      const cut = parts.slice(0, -1).join(' — ').trim()
      if (cut.length >= 4) title = cut
    }
  }

  const head = title.split(SEPARATORS)
  if (head.length >= 2 && namesTheSite(head[0], host, siteName)) {
    const cut = head.slice(1).join(' — ').trim()
    if (cut.length >= 4) title = cut
  }

  return title
}
