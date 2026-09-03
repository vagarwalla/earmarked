/**
 * press — image download and normalization (U3).
 *
 * The renderer must never resolve a network URL (see the plan's Risks table),
 * so every image an article references is fetched here, filtered, and stored
 * in the `press` bucket. What comes out the other side is a local path.
 */

import sharp from 'sharp'
import { safeFetchBytes, SafeFetchError } from './fetch'
import { putObject, storagePath } from './db'
import type { ArticleImage } from './types'

/**
 * Below this on either edge an image is furniture, not content: tracking
 * pixels, spacer gifs, share-button sprites, author avatars.
 */
export const MIN_IMAGE_EDGE = 200
/** A photograph worth a page is never this small. */
export const MIN_IMAGE_BYTES = 4 * 1024

const EXTENSION_BY_FORMAT: Record<string, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif',
  tiff: 'tif',
  svg: 'svg',
}

export interface CandidateImage {
  url: string
  alt: string | null
  caption: string | null
  /**
   * Larger versions of the same picture found in the markup — the `srcset`
   * entries, a `data-` original, or the full plate a thumbnail links to.
   * Tried before `url`, biggest first.
   */
  alternates?: string[]
}

/**
 * How wide a plate we would like to have on hand: the 7in trim at Lulu's
 * 300 PPI, so even a full-bleed opener has the pixels for it. Nothing is
 * upscaled to reach this — it is the ceiling asked of a resizing CDN.
 */
const WANTED_WIDTH_PX = 2100

const IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|gif|avif|tiff?)(?:$|[?#])/i

/** True for a URL that plausibly points at an image file rather than a page. */
export function looksLikeImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && IMAGE_EXTENSION.test(url)
}

/**
 * Bigger versions of an image URL, biggest first, guessed from how the host
 * builds its addresses. Every one of these is a *guess*: the caller tries them
 * in order and falls back to the URL the page actually used, so a 404 here
 * costs one request and nothing else.
 *
 * This matters more than it sounds. Across the nine issues built so far the
 * median stored image is 424 pixels wide, because that is the width Substack
 * puts in its post markup — and 424 pixels across the 384pt measure prints at
 * 79 PPI. The same picture is available from the same CDN at 2,100.
 */
export function largerImageUrls(url: string): string[] {
  const out: string[] = []
  const add = (u: string) => {
    if (u && u !== url && !out.includes(u)) out.push(u)
  }

  // Substack (Cloudinary `image/fetch`): the transform segment carries the
  // width the post was laid out at. `c_limit` means the CDN will not upscale,
  // so asking for more than the original has just returns the original.
  if (/(?:^|\.)substackcdn\.com$/i.test(hostOf(url)) && /\/image\/fetch\//i.test(url)) {
    if (/[,/]w_\d+/.test(url)) {
      add(url.replace(/([,/])w_\d+/, `$1w_${WANTED_WIDTH_PX}`).replace(/([,/])h_\d+/, '$1c_limit'))
    }
    // The origin URL is percent-encoded as the last path segment; that is the
    // uploaded file, at whatever size the author actually posted.
    const origin = /\/(https?%3A%2F%2F[^/]+)$/i.exec(url)?.[1]
    if (origin) {
      try {
        const decoded = decodeURIComponent(origin)
        if (looksLikeImageUrl(decoded)) add(decoded)
      } catch {
        // A malformed escape sequence is just a candidate we do not offer.
      }
    }
  }

  // WordPress and Jetpack hand out `?w=` / `?h=` crops of an original that is
  // still sitting at the same path. Dropping the query gives the full file.
  if (/[?&](?:w|h|resize|fit)=/i.test(url)) {
    const bare = url.replace(/[?&](?:w|h|resize|fit|ssl|quality|strip)=[^&]*/gi, (m) =>
      m[0] === '?' ? '?' : '',
    )
    add(bare.replace(/[?&]$/, ''))
  }

  // WordPress also writes the crop into the filename: `photo-1024x539.jpg`
  // beside `photo.jpg`. Only strip it when both numbers look like dimensions.
  const sized = /^(.*)-(\d{2,4})x(\d{2,4})(\.[a-z0-9]{2,5})(\?.*)?$/i.exec(url)
  if (sized) add(`${sized[1]}${sized[4]}${sized[5] ?? ''}`)

  return out
}

/**
 * The picture an image URL points at, stripped of how big a copy was asked
 * for. Two URLs with the same identity are the same photograph at different
 * sizes — which is how a plate stored from a newsletter (Substack sends
 * `w_424`) is recognised in the live post, where the same picture is served
 * at `w_1456`.
 *
 * Not a security boundary and not canonical: it exists so `press-replate`
 * can line an article's stored plates up against the ones on its page.
 */
export function imageIdentity(url: string): string {
  // Substack/Cloudinary `image/fetch`: everything except the origin URL in
  // the last segment is a transform, and every transform is about size.
  const fetched = /\/image\/fetch\/[^/]*\/(https?%3A%2F%2F.+)$/i.exec(url)
  if (fetched) {
    try {
      return decodeURIComponent(fetched[1])
    } catch {
      return fetched[1]
    }
  }

  return url
    .replace(/[?&](?:w|h|resize|fit|ssl|quality|strip|q)=[^&]*/gi, (m) => (m[0] === '?' ? '?' : ''))
    .replace(/[?&]$/, '')
    .replace(/-(\d{2,4})x(\d{2,4})(\.[a-z0-9]{2,5})(\?.*)?$/i, '$3$4')
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function orientationOf(width: number, height: number): ArticleImage['orientation'] {
  // A little tolerance: a 4:3 photo held slightly off-square is still landscape.
  const ratio = width / height
  if (ratio > 1.05) return 'landscape'
  if (ratio < 0.95) return 'portrait'
  return 'square'
}

/**
 * Obvious non-content images, judged before spending a request on them.
 * Dimensions in the URL are a strong hint; so are the well-known pixel paths.
 */
export function looksLikeTrackingPixel(url: string): boolean {
  const lower = url.toLowerCase()
  if (/\/(?:pixel|beacon|track(?:ing)?|open|spacer|blank|1x1)[./?]/.test(lower)) return true
  if (/[?&](?:width|w)=([1-9]\d?)(?:&|$)/.test(lower)) return true
  const dims = lower.match(/(\d{1,4})x(\d{1,4})\.(?:gif|png|jpe?g)/)
  if (dims && Number(dims[1]) < MIN_IMAGE_EDGE && Number(dims[2]) < MIN_IMAGE_EDGE) return true
  return false
}

export interface StoredImage extends ArticleImage {
  /** The URL it came from — kept for diagnostics, never printed or rendered. */
  sourceUrl: string
}

export interface FetchImageDeps {
  fetchBytes?: typeof safeFetchBytes
  store?: typeof putObject
}

/**
 * Download one image, measure it, and store it. Returns null when the image is
 * not worth printing (too small, unreadable, or refused by the fetch guard) —
 * a missing illustration is not a reason to fail an article.
 */
export async function fetchAndStoreImage(
  itemId: string,
  candidate: CandidateImage,
  index: number,
  deps: FetchImageDeps = {},
): Promise<StoredImage | null> {
  const fetchBytes = deps.fetchBytes ?? safeFetchBytes
  const store = deps.store ?? putObject

  if (looksLikeTrackingPixel(candidate.url)) return null

  // Biggest first: what the markup pointed at as the full plate, then the
  // sizes this host is known to offer, then the one the page displayed. The
  // first that decodes wins, so a wrong guess costs one request.
  const attempts: string[] = []
  for (const url of [
    ...(candidate.alternates ?? []),
    ...largerImageUrls(candidate.url),
    candidate.url,
  ]) {
    if (!attempts.includes(url)) attempts.push(url)
  }

  let bytes: Uint8Array | null = null
  let contentType = ''
  let width: number | null = null
  let height: number | null = null
  let format = ''
  let sourceUrl = candidate.url

  for (const url of attempts) {
    let res: { bytes: Uint8Array; contentType: string }
    try {
      res = await fetchBytes(url)
    } catch (err) {
      // Includes every SafeFetchError: a private-IP image URL is simply dropped.
      const why = err instanceof SafeFetchError ? err.code : (err as Error).message
      console.warn(`press/images: skipping ${url}: ${why}`)
      continue
    }

    if (res.bytes.byteLength < MIN_IMAGE_BYTES) continue
    if (res.contentType && !res.contentType.startsWith('image/')) continue

    let meta: { width?: number; height?: number; format?: string }
    try {
      meta = await sharp(res.bytes).metadata()
    } catch {
      // Not a decodable image, whatever the server claimed.
      continue
    }

    const w = meta.width ?? null
    const h = meta.height ?? null
    if (w !== null && h !== null && w < MIN_IMAGE_EDGE && h < MIN_IMAGE_EDGE) continue

    bytes = res.bytes
    contentType = res.contentType
    width = w
    height = h
    format = meta.format ?? ''
    sourceUrl = url
    break
  }

  if (!bytes) return null

  const ext = EXTENSION_BY_FORMAT[format] ?? 'img'
  const name = `${String(index).padStart(2, '0')}.${ext}`
  const path = storagePath.image(itemId, name)
  await store(path, bytes, contentType || `image/${format || 'jpeg'}`)

  return {
    path,
    alt: candidate.alt,
    caption: candidate.caption,
    width,
    height,
    orientation: width && height ? orientationOf(width, height) : 'landscape',
    sourceUrl,
  }
}

/**
 * Fetch every candidate in order, dropping the ones that do not survive.
 * Sequential on purpose: a personal pipeline gains nothing from hammering a
 * publisher's CDN, and the weekly cadence has all the time in the world.
 */
export async function fetchAndStoreImages(
  itemId: string,
  candidates: CandidateImage[],
  deps: FetchImageDeps = {},
): Promise<StoredImage[]> {
  const stored: StoredImage[] = []
  let index = 0
  for (const candidate of candidates) {
    const image = await fetchAndStoreImage(itemId, candidate, index, deps)
    if (image) {
      stored.push(image)
      index++
    }
  }
  return stored
}
