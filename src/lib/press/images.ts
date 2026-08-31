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

  let bytes: Uint8Array
  let contentType: string
  try {
    const res = await fetchBytes(candidate.url)
    bytes = res.bytes
    contentType = res.contentType
  } catch (err) {
    // Includes every SafeFetchError: a private-IP image URL is simply dropped.
    const why = err instanceof SafeFetchError ? err.code : (err as Error).message
    console.warn(`press/images: skipping ${candidate.url}: ${why}`)
    return null
  }

  if (bytes.byteLength < MIN_IMAGE_BYTES) return null
  if (contentType && !contentType.startsWith('image/')) return null

  let width: number | null = null
  let height: number | null = null
  let format = ''
  try {
    const meta = await sharp(bytes).metadata()
    width = meta.width ?? null
    height = meta.height ?? null
    format = meta.format ?? ''
  } catch {
    // Not a decodable image, whatever the server claimed.
    return null
  }

  if (width !== null && height !== null && width < MIN_IMAGE_EDGE && height < MIN_IMAGE_EDGE) {
    return null
  }

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
    sourceUrl: candidate.url,
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
