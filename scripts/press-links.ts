/**
 * press — harvest the links out of saved articles.
 *
 * The layout engine deliberately drops hyperlinks: print cannot follow them,
 * so `extract.ts` keeps the words and discards the href. That is right for the
 * page and wrong for the reader, because a good newsletter is often mostly a
 * set of pointers. This pulls those pointers back out.
 *
 *   npx tsx scripts/press-links.ts urls.txt
 *   npx tsx scripts/press-links.ts urls.txt --out links.md --min-text 3
 *
 * Everything goes through the same SSRF-guarded fetch as the pipeline, so a
 * URL from an untrusted source cannot make this reach into a private network.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { safeFetchText } from '../src/lib/press/fetch'
import { parseHtml } from '../src/lib/press/extract'
import { normalizeUrl } from '../src/lib/press/db'
import { parseUrlList } from './press-compile'

/** Hosts that are navigation, subscription plumbing, or sharing — never the point. */
const CHROME_HOSTS = [
  'substack.com',
  'substackcdn.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'linkedin.com',
  'reddit.com',
  'mail.google.com',
  't.co',
]

const CHROME_PATHS = [
  /\/subscribe\b/i,
  /\/unsubscribe\b/i,
  /\/account\b/i,
  /\/comments?\b/i,
  /\/share\b/i,
  /\/refer\b/i,
  /\/archive\b/i,
  /\/about\b/i,
  /\/p\/[^/]+\/comments/i,
]

const CHROME_TEXT = [
  /^\s*(share|tweet|subscribe|unsubscribe|comment|like|restack|read more|continue reading|view in browser)\s*$/i,
  /^\s*$/,
]

export interface HarvestedLink {
  url: string
  text: string
  /** Which saved article it was found in. */
  foundIn: string
  host: string
}

export function isChrome(url: string, text: string, sourceHost: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const host = parsed.hostname.replace(/^www\./, '')
  // A link back into the publication you are already reading is navigation.
  if (host === sourceHost) return true
  if (CHROME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true
  if (CHROME_PATHS.some((re) => re.test(parsed.pathname))) return true
  if (CHROME_TEXT.some((re) => re.test(text))) return true
  return false
}

/**
 * Every outbound link in one article, with the words that pointed at it.
 * Anchor text is what makes a harvested link worth anything later.
 */
export function linksIn(html: string, sourceUrl: string, minTextWords = 1): HarvestedLink[] {
  const dom = parseHtml(html, sourceUrl)
  const doc = dom.window.document
  const sourceHost = (() => {
    try {
      return new URL(sourceUrl).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  })()

  // Footers and nav carry the subscription furniture; drop them wholesale.
  for (const sel of ['footer', 'nav', 'header', '.subscription-widget', '.footer']) {
    for (const el of Array.from(doc.querySelectorAll(sel))) el.remove()
  }

  const seen = new Set<string>()
  const out: HarvestedLink[] = []

  for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) continue
    const text = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (isChrome(href, text, sourceHost)) continue
    if (text.split(/\s+/).filter(Boolean).length < minTextWords) continue

    const key = normalizeUrl(href)
    if (!key || seen.has(key)) continue
    seen.add(key)

    out.push({
      url: href,
      text: text.slice(0, 200),
      foundIn: sourceUrl,
      host: new URL(href).hostname.replace(/^www\./, ''),
    })
  }

  return out
}

/** Grouped by destination host, commonest first — the shape that reads well. */
export function toMarkdown(links: HarvestedLink[], sources: Map<string, string>): string {
  const byHost = new Map<string, HarvestedLink[]>()
  for (const link of links) {
    const list = byHost.get(link.host) ?? []
    list.push(link)
    byHost.set(link.host, list)
  }
  const hosts = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))

  const lines = [
    `# Links harvested from ${sources.size} article${sources.size === 1 ? '' : 's'}`,
    '',
    `${links.length} outbound link${links.length === 1 ? '' : 's'} across ${hosts.length} host${hosts.length === 1 ? '' : 's'}, navigation and subscription furniture removed.`,
    '',
  ]

  for (const [host, group] of hosts) {
    lines.push(`## ${host} (${group.length})`, '')
    for (const link of group) {
      const from = sources.get(link.foundIn) ?? link.foundIn
      lines.push(`- [${link.text || link.url}](${link.url})`)
      lines.push(`  <br><sub>via ${from}</sub>`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const positional = argv.filter((a) => !a.startsWith('--'))
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`)
    return i === -1 ? null : (argv[i + 1] ?? null)
  }
  if (positional.length === 0) {
    throw new Error('usage: npx tsx scripts/press-links.ts <urls.txt> [--out links.md] [--min-text N]')
  }

  const urls = parseUrlList(await readFile(positional[0], 'utf8'))
  const minText = Number.parseInt(flag('min-text') ?? '1', 10) || 1
  const outFile = flag('out') ?? 'links.md'

  const all: HarvestedLink[] = []
  const sources = new Map<string, string>()

  for (const [i, url] of urls.entries()) {
    const label = `[${String(i + 1).padStart(2)}/${urls.length}]`
    try {
      const { text: html } = await safeFetchText(url)
      const dom = parseHtml(html, url)
      const title = dom.window.document.querySelector('h1')?.textContent?.trim() || dom.window.document.title?.trim() || url
      sources.set(url, title)

      const links = linksIn(html, url, minText)
      all.push(...links)
      console.log(`${label} ${links.length.toString().padStart(3)} links  ${title}`)
    } catch (err) {
      console.log(`${label}   ✗       ${url}\n              ${(err as Error).message}`)
    }
  }

  await writeFile(outFile, toMarkdown(all, sources))
  console.log(`\n   ${all.length} links → ${outFile}`)
}

// Only run when invoked directly; press-compile.ts imports parseUrlList from here's sibling.
if (process.argv[1]?.endsWith('press-links.ts')) {
  main().catch((err) => {
    console.error(`\npress: ${(err as Error).message}`)
    process.exit(1)
  })
}
