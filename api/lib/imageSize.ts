/**
 * Intrinsic image dimensions from the file header (#25).
 *
 * Stored at upload so the client can reserve the right box before the bytes
 * arrive. Without width and height there is no way to prevent layout shift,
 * and layout shift is the accessibility failure people actually notice.
 *
 * Header parsing only — no decoding, no dependency. Returns null rather than
 * guessing when a format is not understood; a missing dimension degrades to
 * the old behaviour, a wrong one breaks the page.
 */
export type ImageSize = { width: number; height: number } | null

export function imageSize(bytes: Uint8Array, mimeType: string): ImageSize {
  switch (mimeType) {
    case 'image/png':  return pngSize(bytes)
    case 'image/jpeg': return jpegSize(bytes)
    case 'image/webp': return webpSize(bytes)
    case 'image/avif': return avifSize(bytes)
    default:           return null
  }
}

const u16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
const u32 = (b: Uint8Array, i: number) =>
  (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0
const u24le = (b: Uint8Array, i: number) =>
  (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)

function ascii(b: Uint8Array, i: number, length: number): string {
  return String.fromCharCode(...b.subarray(i, i + length))
}

function pngSize(b: Uint8Array): ImageSize {
  // 8-byte signature, then the IHDR chunk: length, type, width, height.
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
  return { width: u32(b, 16), height: u32(b, 20) }
}

function jpegSize(b: Uint8Array): ImageSize {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const marker = b[i + 1] ?? 0
    // SOF0-3, 5-7, 9-11, 13-15 carry the frame dimensions. DHT/DQT and the
    // rest are skipped by their declared length.
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame) return { width: u16(b, i + 7), height: u16(b, i + 5) }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue }
    const length = u16(b, i + 2)
    if (length < 2) return null
    i += 2 + length
  }
  return null
}

function webpSize(b: Uint8Array): ImageSize {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null
  const chunk = ascii(b, 12, 4)

  if (chunk === 'VP8X') {
    // Extended format: canvas size is stored minus one, 24-bit little-endian.
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  }
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte start code, then 14-bit dimensions.
    return {
      width: ((b[27] ?? 0) << 8 | (b[26] ?? 0)) & 0x3fff,
      height: ((b[29] ?? 0) << 8 | (b[28] ?? 0)) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    // Lossless: 1-byte signature, then 14 bits width and 14 bits height.
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function avifSize(b: Uint8Array): ImageSize {
  // ISOBMFF: rather than walk the box tree, find the ispe (image spatial
  // extents) box, which is where the dimensions live regardless of nesting.
  for (let i = 0; i + 20 < b.length; i++) {
    if (ascii(b, i, 4) !== 'ispe') continue
    // 4 bytes of version and flags follow the box type.
    const width = u32(b, i + 8)
    const height = u32(b, i + 12)
    if (width > 0 && height > 0 && width < 100_000 && height < 100_000) return { width, height }
  }
  return null
}
