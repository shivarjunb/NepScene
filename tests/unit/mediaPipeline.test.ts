import { describe, expect, it } from 'vitest'
import {
  checkDerivative, contentHash, derivativeKey, originalKey, WIDTHS, widthsFor,
} from '../../api/media/pipeline'

/**
 * #25 — the rules a derivative has to satisfy before it is stored. Nothing here
 * trusts the request: every width, height and format is read from the uploaded
 * file's own header, so these are the checks that make client-side encoding
 * safe rather than a promise.
 */
const original = { width: 1920, height: 1080 }
const bytes = (n: number) => n

describe('the width ladder', () => {
  it('stops at the original rather than upscaling it', () => {
    // A 500px flyer blown up to 1440 invents detail and costs bytes.
    expect(widthsFor(500)).toEqual([320, 500])
  })

  it('offers every rung for an image wider than all of them', () => {
    expect(widthsFor(4000)).toEqual([...WIDTHS])
  })

  it('never offers a rung as wide as the original twice', () => {
    const rungs = widthsFor(640)
    expect(rungs).toEqual([320, 640])
    expect(new Set(rungs).size).toBe(rungs.length)
  })
})

describe('content-addressed keys', () => {
  it('is stable for identical content', async () => {
    const a = await contentHash(new Uint8Array([1, 2, 3]))
    const b = await contentHash(new Uint8Array([1, 2, 3]))
    expect(a).toBe(b)
  })

  it('differs for different content', async () => {
    const a = await contentHash(new Uint8Array([1, 2, 3]))
    const b = await contentHash(new Uint8Array([1, 2, 4]))
    expect(a).not.toBe(b)
  })

  it('puts the original and its derivatives under the listing', async () => {
    const hash = await contentHash(new Uint8Array([1]))
    expect(originalKey('lst_1', hash, 'png')).toBe(`listings/lst_1/${hash}.png`)
    expect(derivativeKey('lst_1', hash, 640, 'webp')).toBe(`listings/lst_1/${hash}-640.webp`)
  })
})

describe('what counts as a derivative', () => {
  const check = (over: Partial<Parameters<typeof checkDerivative>[0]> = {}) =>
    checkDerivative({
      bytes: bytes(50_000),
      mimeType: 'image/webp',
      size: { width: 640, height: 360 },
      original,
      ...over,
    })

  it('accepts a rung of the right shape', () => {
    expect(check()).toEqual({ ok: true, width: 640, height: 360, format: 'webp' })
  })

  it('refuses a format nothing can display', () => {
    expect(check({ mimeType: 'image/gif' })).toEqual({ ok: false, reason: 'unsupported_type' })
  })

  it('refuses a file whose header will not parse', () => {
    // No dimensions means no reserved box, which means layout shift.
    expect(check({ size: null })).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('refuses a width that is not on the ladder', () => {
    expect(check({ size: { width: 700, height: 394 } })).toEqual({ ok: false, reason: 'not_a_rung' })
  })

  it('refuses something wider than what it claims to derive from', () => {
    expect(check({ size: { width: 2400, height: 1350 } }))
      .toEqual({ ok: false, reason: 'wider_than_original' })
  })

  it('refuses a different picture wearing the right width', () => {
    // 640x640 is a rung, but it is not this image.
    expect(check({ size: { width: 640, height: 640 } }))
      .toEqual({ ok: false, reason: 'different_image' })
  })

  it('tolerates the rounding a resize does to an odd dimension', () => {
    // 1920x1080 scaled to 640 is 360.0; a 359 or 361 is the same picture.
    expect(check({ size: { width: 640, height: 361 } })).toMatchObject({ ok: true })
    expect(check({ size: { width: 640, height: 359 } })).toMatchObject({ ok: true })
  })

  it('refuses one that is bigger than the cap', () => {
    expect(check({ bytes: 5 * 1024 * 1024 })).toEqual({ ok: false, reason: 'too_large' })
  })

  it('accepts the original width itself when the image is narrow', () => {
    expect(checkDerivative({
      bytes: bytes(10_000), mimeType: 'image/avif',
      size: { width: 500, height: 500 }, original: { width: 500, height: 500 },
    })).toMatchObject({ ok: true, width: 500, format: 'avif' })
  })
})
