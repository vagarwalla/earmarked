/**
 * press — the one guarded HTTP client.
 *
 * Every server-side fetch in the pipeline goes through here: article pages,
 * images, the Raindrop permanent-copy cache. The email door accepts URLs from
 * anyone who finds the address, so a URL arriving in the queue is attacker
 * input, and the worker that fetches it sits inside a private network with a
 * cloud metadata endpoint one hop away. That makes this module the SSRF
 * surface for the whole feature (see the Risks table in the plan).
 *
 * The rules, in order of application:
 *   1. http(s) only — no file:, gopher:, data:, ftp:.
 *   2. Every hop's host is resolved and every resolved address must be a
 *      public unicast address. Literal IPs are checked the same way.
 *   3. Redirects are followed manually, capped, and re-checked at each hop —
 *      a public host that 302s to 169.254.169.254 is refused at the second hop.
 *   4. One deadline covers the whole redirect chain; the body is read with a
 *      hard byte cap so a slow or endless response cannot pin the worker.
 *   5. Credentials are dropped when a redirect crosses origins.
 */

import { lookup } from 'node:dns/promises'

/** Plain and identifying — no browser cosplay; this is a personal tool. */
export const PRESS_USER_AGENT =
  'earmarked-press/1.0 (+https://github.com/vagarwalla/earmarked; personal reading-to-print pipeline)'

export const MAX_REDIRECTS = 5
export const DEFAULT_TIMEOUT_MS = 20_000
/** Generous for an article page or a magazine-sized photograph, mean for anything else. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export type SafeFetchErrorCode =
  | 'scheme'
  | 'hostname'
  | 'dns'
  | 'blocked-address'
  | 'too-many-redirects'
  | 'too-large'

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly url?: string,
  ) {
    super(message)
    this.name = 'SafeFetchError'
  }
}

// ── Address classification ───────────────────────────────────────────────────
// Exported separately from the fetch path so the ranges can be unit-tested
// exhaustively without touching DNS.

function parseIPv4(text: string): number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    // Strict decimal dotted-quad only. `new URL()` has already canonicalized
    // the octal/hex/integer spellings (0177.0.0.1, 2130706433) into this form.
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    bytes.push(n)
  }
  return bytes
}

/** Returns the 16 bytes of an IPv6 address, or null if `text` is not one. */
function parseIPv6(text: string): number[] | null {
  const zone = text.indexOf('%')
  const body = zone >= 0 ? text.slice(0, zone) : text
  if (!body.includes(':')) return null

  const halves = body.split('::')
  if (halves.length > 2) return null

  const groups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    const pieces = part.split(':')
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]
      if (piece.includes('.')) {
        // A dotted-quad tail (::ffff:127.0.0.1) is legal only as the last piece.
        if (i !== pieces.length - 1) return null
        const v4 = parseIPv4(piece)
        if (!v4) return null
        out.push(...v4)
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null
      const n = Number.parseInt(piece, 16)
      out.push(n >> 8, n & 0xff)
    }
    return out
  }

  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  if (!head || !tail) return null

  if (halves.length === 1) return head.length === 16 ? head : null

  const missing = 16 - head.length - tail.length
  // `::` must stand for at least one elided group, or the address was spelled out.
  if (missing < 2) return null
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}

/** [network, prefix length, why it is refused] */
const V4_BLOCKS: readonly [string, number, string][] = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (cloud metadata)'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved / broadcast'],
]

const V6_BLOCKS: readonly [string, number, string][] = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['100::', 64, 'discard-only'],
  ['2001::', 32, 'Teredo'],
  ['2001:db8::', 32, 'documentation'],
  ['fc00::', 7, 'unique local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local (deprecated)'],
  ['ff00::', 8, 'multicast'],
]

function matchesPrefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  const whole = bits >> 3
  for (let i = 0; i < whole; i++) if (bytes[i] !== prefix[i]) return false
  const rest = bits & 7
  if (rest === 0) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return (bytes[whole] & mask) === (prefix[whole] & mask)
}

function classifyIPv4(bytes: number[]): string | null {
  for (const [net, bits, why] of V4_BLOCKS) {
    const prefix = parseIPv4(net)
    if (prefix && matchesPrefix(bytes, prefix, bits)) return why
  }
  return null
}

function classifyIPv6(bytes: number[]): string | null {
  // Addresses that carry an IPv4 address inside them are judged on that
  // address: ::ffff:127.0.0.1 and 64:ff9b::169.254.169.254 both reach v4
  // destinations, and 2002::/16 tunnels to the embedded v4 relay.
  const embedded =
    matchesPrefix(bytes, parseIPv6('::ffff:0:0')!, 96) || matchesPrefix(bytes, parseIPv6('64:ff9b::')!, 96)
      ? bytes.slice(12, 16)
      : matchesPrefix(bytes, parseIPv6('2002::')!, 16)
        ? bytes.slice(2, 6)
        : null
  if (embedded) return classifyIPv4(embedded)

  for (const [net, bits, why] of V6_BLOCKS) {
    const prefix = parseIPv6(net)
    if (prefix && matchesPrefix(bytes, prefix, bits)) return why
  }
  return null
}

/**
 * Why this address must not be fetched, or null if it is an ordinary public
 * unicast address. Anything unparseable is refused: the guard fails closed,
 * because "we could not tell what this is" is not a reason to connect to it.
 */
export function blockedAddressReason(address: string): string | null {
  const v4 = parseIPv4(address)
  if (v4) return classifyIPv4(v4)
  const v6 = parseIPv6(address)
  if (v6) return classifyIPv6(v6)
  return 'unparseable address'
}

/** The predicate the fetch path is built on. See `blockedAddressReason` for the why. */
export function isBlockedAddress(address: string): boolean {
  return blockedAddressReason(address) !== null
}

/** Names that never point anywhere public, whatever the resolver says. */
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.onion']

// ── DNS ──────────────────────────────────────────────────────────────────────

export type DnsLookup = (hostname: string) => Promise<string[]>

const systemLookup: DnsLookup = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((r) => r.address)
}

let dnsLookup: DnsLookup = systemLookup

/** Test hook: swap the resolver, or reset with null. Tests must never hit real DNS. */
export function __setDnsLookup(fn: DnsLookup | null): void {
  dnsLookup = fn ?? systemLookup
}

/**
 * Check one hop. Throws unless the URL is http(s) and every address its host
 * resolves to is public.
 *
 * Note the residual TOCTOU: we resolve here and the socket resolves again.
 * Pinning the checked address would need a custom agent per request; for a
 * personal pipeline the rebinding window is not worth that machinery, and the
 * per-hop re-check below closes the redirect hole that actually gets exploited.
 */
export async function assertPublicUrl(url: string | URL): Promise<URL> {
  const parsed = url instanceof URL ? url : new URL(url)

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SafeFetchError('scheme', `refusing non-http(s) URL: ${parsed.protocol}`, String(url))
  }

  // `new URL()` leaves IPv6 literals in brackets.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw new SafeFetchError('hostname', 'refusing URL with no host', String(url))
  if (BLOCKED_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
    throw new SafeFetchError('hostname', `refusing internal hostname: ${host}`, String(url))
  }

  // A literal address needs no resolver.
  const literal = /^[\d.]+$/.test(host) || host.includes(':')
  const addresses = literal ? [host] : await resolveOrThrow(host, String(url))

  for (const address of addresses) {
    const why = blockedAddressReason(address)
    if (why) {
      throw new SafeFetchError(
        'blocked-address',
        `refusing ${host} → ${address} (${why})`,
        String(url),
      )
    }
  }
  return parsed
}

async function resolveOrThrow(host: string, url: string): Promise<string[]> {
  let addresses: string[]
  try {
    addresses = await dnsLookup(host)
  } catch (err) {
    throw new SafeFetchError('dns', `could not resolve ${host}: ${(err as Error).message}`, url)
  }
  if (addresses.length === 0) throw new SafeFetchError('dns', `${host} resolved to nothing`, url)
  return addresses
}

// ── The client ───────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

/** Headers that must not survive a redirect to a different origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

/**
 * Read a response body with a hard cap. Streaming rather than `arrayBuffer()`
 * so a response that lies about (or omits) Content-Length still cannot grow
 * without bound.
 */
async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SafeFetchError('too-large', `${url} declares ${declared} bytes (cap ${maxBytes})`, url)
  }
  if (!res.body) return new Uint8Array(0)

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new SafeFetchError('too-large', `${url} exceeded ${maxBytes} bytes`, url)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * The pipeline's only outbound HTTP call.
 *
 * Returns a fully-buffered Response (body already read and capped) whose `url`
 * is the final hop, so callers can resolve relative links against where they
 * actually landed.
 */
export async function safeFetch(url: string, init: RequestInit & SafeFetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
    maxRedirects = MAX_REDIRECTS,
    ...requestInit
  } = init

  // One deadline for the whole chain — five hops of 20s each is not a timeout.
  const deadline = AbortSignal.timeout(timeoutMs)

  const headers = new Headers(requestInit.headers)
  if (!headers.has('user-agent')) headers.set('user-agent', PRESS_USER_AGENT)
  if (!headers.has('accept-language')) headers.set('accept-language', 'en-US,en;q=0.9')

  let current = await assertPublicUrl(url)
  let method = requestInit.method ?? 'GET'
  let body = requestInit.body

  for (let hop = 0; ; hop++) {
    const res = await fetch(current, {
      ...requestInit,
      method,
      body,
      headers,
      redirect: 'manual',
      signal: deadline,
    })

    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) {
      const bytes = await readCapped(res, maxBytes, current.href)
      // A Uint8Array is a valid runtime body; the DOM lib's BodyInit only
      // admits Uint8Array<ArrayBuffer>, which a stream-assembled array is not.
      const buffered = new Response(bytes as unknown as BodyInit, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
      // `Response.url` is empty on a constructed response; callers need the
      // hop we actually landed on to resolve relative URLs.
      Object.defineProperty(buffered, 'url', { value: current.href })
      return buffered
    }

    if (hop >= maxRedirects) {
      throw new SafeFetchError('too-many-redirects', `${url}: more than ${maxRedirects} redirects`, url)
    }

    const next = new URL(location, current)
    // The whole point of the loop: the target of a redirect is as untrusted as
    // the URL that arrived in the queue.
    await assertPublicUrl(next)

    if (next.origin !== current.origin) {
      for (const name of CREDENTIAL_HEADERS) headers.delete(name)
    }
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      method = method === 'HEAD' ? 'HEAD' : 'GET'
      body = undefined
    }
    // Drain the redirect body so the socket can be reused.
    await res.body?.cancel()
    current = next
  }
}

/** `safeFetch` plus the two things every caller then does. */
export async function safeFetchText(
  url: string,
  init: RequestInit & SafeFetchOptions = {},
): Promise<{ text: string; url: string; status: number }> {
  const res = await safeFetch(url, init)
  return { text: await res.text(), url: res.url || url, status: res.status }
}

export async function safeFetchBytes(
  url: string,
  init: RequestInit & SafeFetchOptions = {},
): Promise<{ bytes: Uint8Array; url: string; status: number; contentType: string }> {
  const res = await safeFetch(url, init)
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    url: res.url || url,
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
  }
}
