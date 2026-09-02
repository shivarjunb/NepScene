import { describe, expect, it } from 'vitest'
import { imageSize } from '../../api/lib/imageSize'

/** Minimal, valid headers — enough of each format for the parser to be real. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  b.set([0, 0, 0, 13], 8)
  b.set([...'IHDR'].map((c) => c.charCodeAt(0)), 12)
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, a JFIF APP0 to be skipped by length, then SOF0 carrying the size.
  const b = new Uint8Array(40)
  const view = new DataView(b.buffer)
  b.set([0xff, 0xd8], 0)
  b.set([0xff, 0xe0], 2); view.setUint16(4, 16)      // APP0, length 16
  b.set([0xff, 0xc0], 20); view.setUint16(22, 17)    // SOF0
  b[24] = 8
  view.setUint16(25, height)
  view.setUint16(27, width)
  return b
}

function webpVP8X(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8)
  b.set([...'VP8X'].map((c) => c.charCodeAt(0)), 12)
  const w = width - 1, h = height - 1
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24)
  b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27)
  return b
}

describe('imageSize', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(imageSize(png(1200, 630), 'image/png')).toEqual({ width: 1200, height: 630 })
  })

  it('reads JPEG dimensions from the frame header, skipping APP0', () => {
    expect(imageSize(jpeg(1920, 1080), 'image/jpeg')).toEqual({ width: 1920, height: 1080 })
  })

  it('reads WebP dimensions, which are stored minus one', () => {
    expect(imageSize(webpVP8X(800, 600), 'image/webp')).toEqual({ width: 800, height: 600 })
  })

  it('returns null rather than guessing on a format it cannot read', () => {
    expect(imageSize(png(10, 10), 'image/gif')).toBeNull()
    expect(imageSize(new Uint8Array([1, 2, 3]), 'image/png')).toBeNull()
    expect(imageSize(new Uint8Array(0), 'image/jpeg')).toBeNull()
  })

  it('does not mistake a truncated file for a valid one', () => {
    expect(imageSize(png(100, 100).subarray(0, 15), 'image/png')).toBeNull()
  })
})
