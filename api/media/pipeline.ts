/**
 * The media pipeline's rules (#25), kept apart from the handler so they are
 * testable without a request, an R2 bucket or a multipart body.
 *
 * Where derivatives come from
 * ---------------------------
 * The browser encodes them and uploads them alongside the original; the Worker
 * verifies every one before it is stored. Three things decided that:
 *
 *   - This deploys to workers.dev, which has no zone, so Cloudflare's image
 *     resizing (`/cdn-cgi/image/…`) is not reachable at all.
 *   - Encoding AVIF in the Worker means a WASM codec inside the request's CPU
 *     budget, for an image the uploading device has already decoded.
 *   - Whatever encodes them, the acceptance criteria are all on the read path:
 *     derivatives exist, srcset picks one, the feed stays under 500KB.
 *
 * So nothing here trusts the client's *claims* — no width, format or size is
 * taken from the request. Each part is parsed from its own header and checked
 * against the original. What a client can do is upload a worse image of its own
 * listing, which it could do anyway by uploading it as the original.
 *
 * An importer with no browser simply uploads no derivatives: the original is
 * served on its own and the page is heavier. Degraded, not broken.
 */
import { imageSize, type ImageSize } from '../lib/imageSize'

/**
 * The ladder. Four rungs covering a 320px phone through a 2x desktop card,
 * because a fifth costs an upload and saves nobody a byte they notice.
 */
export const WIDTHS = [320, 640, 960, 1440] as const

export const FORMATS = {
  'image/avif': 'avif',
  'image/webp': 'webp',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
} as const

export type Format = (typeof FORMATS)[keyof typeof FORMATS]

/** Preference order for `<picture>`: best compression first, fallback last. */
export const FORMAT_ORDER: Format[] = ['avif', 'webp', 'jpeg', 'png']

export const MIME_BY_FORMAT: Record<Format, string> = {
  avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png',
}

export const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024
/** A derivative larger than this is not a derivative, whatever it claims. */
export const MAX_DERIVATIVE_BYTES = 2 * 1024 * 1024
/** Enough of a file to hold any header imageSize() reads. */
export const HEADER_BYTES = 64 * 1024

/**
 * Which rungs are worth generating for an original of this width. Upscaling a
 * 500px flyer to 1440 invents detail and costs bytes, so the ladder stops at
 * the original.
 */
export function widthsFor(originalWidth: number): number[] {
  const rungs = WIDTHS.filter((width) => width < originalWidth)
  return rungs.length === WIDTHS.length ? [...rungs] : [...rungs, originalWidth]
}

/** SHA-256 of the bytes, hex. The key is a function of the content. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function originalKey(listingId: string, hash: string, format: Format): string {
  return `listings/${listingId}/${hash}.${format}`
}

export function derivativeKey(
  listingId: string, hash: string, width: number, format: Format,
): string {
  return `listings/${listingId}/${hash}-${width}.${format}`
}

export type Original = { width: number; height: number }

export type DerivativeRejection =
  | 'unsupported_type'
  | 'too_large'
  | 'unreadable'
  | 'not_a_rung'
  | 'wider_than_original'
  | 'different_image'

/**
 * A derivative has to be the same picture, smaller. Aspect ratio is how that is
 * checked: a client cannot pass off an unrelated image as the 640px version of
 * this one without also matching its shape.
 *
 * The tolerance is 2%, which absorbs the rounding a resize does to an odd
 * dimension and rejects anything that has actually been recropped.
 */
const ASPECT_TOLERANCE = 0.02

export function checkDerivative(
  { bytes, mimeType, size, original }:
  { bytes: number; mimeType: string; size: ImageSize; original: Original },
): { ok: true; width: number; height: number; format: Format }
  | { ok: false; reason: DerivativeRejection } {
  const format = FORMATS[mimeType as keyof typeof FORMATS]
  if (!format) return { ok: false, reason: 'unsupported_type' }
  if (bytes > MAX_DERIVATIVE_BYTES) return { ok: false, reason: 'too_large' }
  // Dimensions come from the file's own header, never from the request.
  if (!size) return { ok: false, reason: 'unreadable' }
  if (size.width > original.width) return { ok: false, reason: 'wider_than_original' }
  if (!widthsFor(original.width).includes(size.width)) return { ok: false, reason: 'not_a_rung' }

  const wanted = original.width / original.height
  const actual = size.width / size.height
  if (Math.abs(actual - wanted) / wanted > ASPECT_TOLERANCE) {
    return { ok: false, reason: 'different_image' }
  }

  return { ok: true, width: size.width, height: size.height, format }
}

/** Reads the intrinsic size of an upload part from its header alone. */
export function sizeOf(bytes: Uint8Array, mimeType: string): ImageSize {
  return imageSize(bytes.subarray(0, HEADER_BYTES), mimeType)
}
