import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

/**
 * #25 — the media pipeline end to end: upload, derivative verification, the
 * srcset the catalogue serves, and what happens to the bytes on delete.
 */

/** A PNG that a header parser can read the dimensions of. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  b.set([0, 0, 0, 13], 8)
  b.set([...'IHDR'].map((c) => c.charCodeAt(0)), 12)
  const view = new DataView(b.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  // Padding so two images of the same size are not the same bytes.
  return b
}

/** A WebP in the extended (VP8X) form, whose canvas size is stored minus one. */
function webp(width: number, height: number): Uint8Array {
  const b = new Uint8Array(32)
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8)
  b.set([...'VP8X'].map((c) => c.charCodeAt(0)), 12)
  const le24 = (at: number, value: number) => {
    b[at] = value & 0xff
    b[at + 1] = (value >> 8) & 0xff
    b[at + 2] = (value >> 16) & 0xff
  }
  le24(24, width - 1)
  le24(27, height - 1)
  return b
}

/** An AVIF is found by its ispe box wherever it is nested. */
function avif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(64)
  b.set([...'ftypavif'].map((c) => c.charCodeAt(0)), 4)
  b.set([...'ispe'].map((c) => c.charCodeAt(0)), 24)
  const view = new DataView(b.buffer)
  view.setUint32(24 + 8, width)
  view.setUint32(24 + 12, height)
  return b
}

let ipCounter = 0
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`

async function signIn(email: string, role: 'organizer' | 'editor' | 'admin'): Promise<string> {
  const response = await SELF.fetch('https://nepscene.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email, password: 'a-decent-passphrase' }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  await env.DB.prepare('UPDATE users SET role = ?1 WHERE email = ?2').bind(role, email).run()
  return cookie
}

type Part = { bytes: Uint8Array; type: string; name: string }

async function upload(cookie: string, listingId: string, {
  original = { bytes: png(1920, 1080), type: 'image/png', name: 'poster.png' },
  derivatives = [] as Part[],
  altText = 'A crowd at Purple Haze',
} = {}) {
  const form = new FormData()
  form.set('file', new File([original.bytes], original.name, { type: original.type }))
  form.set('alt_text', altText)
  for (const part of derivatives) {
    form.append('derivative', new File([part.bytes], part.name, { type: part.type }))
  }
  const response = await SELF.fetch(
    `https://nepscene.test/api/author/listings/${listingId}/media`,
    { method: 'POST', headers: { cookie }, body: form },
  )
  return { response, body: (await response.json()) as any }
}

const LADDER: Part[] = [
  { bytes: avif(320, 180), type: 'image/avif', name: '320.avif' },
  { bytes: avif(640, 360), type: 'image/avif', name: '640.avif' },
  { bytes: webp(320, 180), type: 'image/webp', name: '320.webp' },
  { bytes: webp(960, 540), type: 'image/webp', name: '960.webp' },
]

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM organization_users'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
  for (const object of (await env.MEDIA.list({ prefix: 'listings/' })).objects) {
    await env.MEDIA.delete(object.key)
  }
})

describe('uploading an original', () => {
  it('keys it by its content, not by a generated id', async () => {
    const cookie = await signIn('a@example.np', 'editor')
    const { response, body } = await upload(cookie, 'lst_soon')

    expect(response.status).toBe(201)
    expect(body.url).toMatch(/^\/api\/media\/listings\/lst_soon\/[0-9a-f]{64}\.png$/)
    expect(await env.MEDIA.head(body.url.replace('/api/media/', ''))).not.toBeNull()
  })

  it('writes the same key for the same bytes instead of a second copy', async () => {
    const cookie = await signIn('b@example.np', 'editor')
    const first = await upload(cookie, 'lst_soon')
    const second = await upload(cookie, 'lst_soon')

    expect(second.response.status).toBe(200)
    expect(second.body.id).toBe(first.body.id)
    expect(second.body.url).toBe(first.body.url)

    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM listing_media WHERE listing_id = ?1',
    ).bind('lst_soon').first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  it('refuses an image whose header will not parse', async () => {
    // Without dimensions there is no box to reserve, so this cannot be stored
    // and still meet "images reserve space before load".
    const cookie = await signIn('c@example.np', 'editor')
    const { response, body } = await upload(cookie, 'lst_soon', {
      original: { bytes: new Uint8Array([137, 80, 78, 71]), type: 'image/png', name: 'broken.png' },
    })
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('unreadable_image')
  })

  it('says which widths it expected, so a partial upload is visible', async () => {
    const cookie = await signIn('d@example.np', 'editor')
    const { body } = await upload(cookie, 'lst_soon')
    expect(body.expected_widths).toEqual([320, 640, 960, 1440])
  })
})

describe('verifying derivatives', () => {
  it('stores the ones that check out', async () => {
    const cookie = await signIn('e@example.np', 'editor')
    const { body } = await upload(cookie, 'lst_soon', { derivatives: LADDER })

    expect(body.derivatives).toHaveLength(4)
    expect(body.rejected).toEqual([])
    for (const derivative of body.derivatives) {
      expect(await env.MEDIA.head(derivative.url.replace('/api/media/', ''))).not.toBeNull()
    }
  })

  it('rejects a different picture wearing the right width, and keeps the rest', async () => {
    const cookie = await signIn('f@example.np', 'editor')
    const { body } = await upload(cookie, 'lst_soon', {
      derivatives: [
        ...LADDER.slice(0, 2),
        // 640 wide but square: not this image.
        { bytes: webp(640, 640), type: 'image/webp', name: 'other.webp' },
      ],
    })

    expect(body.derivatives).toHaveLength(2)
    expect(body.rejected).toEqual([{ width: null, reason: 'different_image' }])
  })

  it('rejects a width that is not on the ladder', async () => {
    const cookie = await signIn('g@example.np', 'editor')
    const { body } = await upload(cookie, 'lst_soon', {
      derivatives: [{ bytes: webp(700, 394), type: 'image/webp', name: '700.webp' }],
    })
    expect(body.rejected).toEqual([{ width: null, reason: 'not_a_rung' }])
  })

  it('rejects one wider than the original it claims to come from', async () => {
    const cookie = await signIn('h@example.np', 'editor')
    const { body } = await upload(cookie, 'lst_soon', {
      original: { bytes: png(640, 360), type: 'image/png', name: 'small.png' },
      derivatives: [{ bytes: webp(960, 540), type: 'image/webp', name: '960.webp' }],
    })
    expect(body.rejected).toEqual([{ width: null, reason: 'wider_than_original' }])
  })

  it('keeps one variant per format and width when the same rung arrives twice', async () => {
    const cookie = await signIn('i@example.np', 'editor')
    const { body } = await upload(cookie, 'lst_soon', {
      derivatives: [LADDER[0]!, LADDER[0]!],
    })
    expect(body.derivatives).toHaveLength(1)
    expect(body.rejected).toEqual([{ width: 320, reason: 'duplicate_variant' }])
  })

  it('does not double the srcset when the whole upload is retried', async () => {
    const cookie = await signIn('j@example.np', 'editor')
    await upload(cookie, 'lst_soon', { derivatives: LADDER })
    await upload(cookie, 'lst_soon', { derivatives: LADDER })

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM media_derivatives d
         JOIN listing_media m ON m.id = d.media_id WHERE m.listing_id = 'lst_soon'`,
    ).first<{ n: number }>()
    expect(rows?.n).toBe(4)
  })
})

describe('what the catalogue serves', () => {
  it('offers modern formats first, with the original as the fallback', async () => {
    const cookie = await signIn('k@example.np', 'editor')
    await upload(cookie, 'lst_soon', { derivatives: LADDER })

    const body = await (await SELF.fetch('https://nepscene.test/api/catalog/listings/rock-night')).json() as any
    const image = body.media[0]

    expect(image.sources.map((s: any) => s.type)).toEqual(['image/avif', 'image/webp', 'image/png'])
    // The srcset the browser chooses from, narrowest first.
    expect(image.sources[0].srcset).toMatch(/ 320w, .* 640w$/)
    expect(image.url).toMatch(/\.png$/)
  })

  it('puts the original in the srcset of its own format at its own width', async () => {
    // Otherwise a browser with only the PNG picks a smaller image than it has.
    const cookie = await signIn('l@example.np', 'editor')
    await upload(cookie, 'lst_soon', { derivatives: LADDER })

    const body = await (await SELF.fetch('https://nepscene.test/api/catalog/listings/rock-night')).json() as any
    const png = body.media[0].sources.find((s: any) => s.type === 'image/png')
    expect(png.srcset).toMatch(/ 1920w$/)
  })

  it('reserves the box before the bytes arrive', async () => {
    const cookie = await signIn('m@example.np', 'editor')
    await upload(cookie, 'lst_soon', { derivatives: LADDER })

    const body = await (await SELF.fetch('https://nepscene.test/api/catalog/listings/rock-night')).json() as any
    expect(body.media[0]).toMatchObject({ width: 1920, height: 1080 })
    expect(body.media[0].aspect_ratio).toBeCloseTo(1920 / 1080, 3)
  })

  it('gives every feed row a cover with a small rung, not just the original', async () => {
    // This is the criterion the feed's weight rests on: without derivatives on
    // the summary, a card on a phone downloads the full-size banner.
    const cookie = await signIn('n@example.np', 'editor')
    await upload(cookie, 'lst_soon', { derivatives: LADDER })

    const body = await (await SELF.fetch('https://nepscene.test/api/catalog/listings')).json() as any
    const withCover = body.data.filter((l: any) => l.cover)
    expect(withCover).toHaveLength(1)
    expect(withCover[0].cover.sources[0].srcset).toContain('320w')
  })

  it('leaves cover null for a listing that has no image at all', async () => {
    // A distinct cache key: seeding writes straight to D1, so it does not bump
    // the catalog version stamp the way a published listing would, and the
    // previous test's response is still at the edge under the bare path.
    const body = await (await SELF.fetch(
      'https://nepscene.test/api/catalog/listings?limit=25')).json() as any
    expect(body.data.every((l: any) => l.cover === null)).toBe(true)
  })

  it('serves a derivative with an immutable cache header', async () => {
    // Safe only because the key is a hash: the content behind it cannot change.
    const cookie = await signIn('o@example.np', 'editor')
    const { body } = await upload(cookie, 'lst_soon', { derivatives: LADDER })
    const response = await SELF.fetch(`https://nepscene.test${body.derivatives[0].url}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('immutable')
  })
})

describe('cleaning up', () => {
  it('takes the derivatives with the image', async () => {
    const cookie = await signIn('p@example.np', 'editor')
    const { body } = await upload(cookie, 'lst_soon', { derivatives: LADDER })
    const keys = [body.url, ...body.derivatives.map((d: any) => d.url)]
      .map((url: string) => url.replace('/api/media/', ''))

    const response = await SELF.fetch(`https://nepscene.test/api/author/media/${body.id}`, {
      method: 'DELETE', headers: { cookie },
    })
    expect(((await response.json()) as any).deleted_objects).toBe(5)
    for (const key of keys) expect(await env.MEDIA.head(key)).toBeNull()
  })

  it('takes them with the listing too', async () => {
    const cookie = await signIn('q@example.np', 'editor')
    const { body } = await upload(cookie, 'lst_soon', { derivatives: LADDER })

    const response = await SELF.fetch('https://nepscene.test/api/author/listings/lst_soon', {
      method: 'DELETE', headers: { cookie },
    })
    expect(((await response.json()) as any).deleted_media).toBe(5)
    expect(await env.MEDIA.head(body.url.replace('/api/media/', ''))).toBeNull()
  })

  it('finds objects nothing references, and does not delete them unasked', async () => {
    const cookie = await signIn('r@example.np', 'admin')
    await upload(cookie, 'lst_soon', { derivatives: LADDER })
    // The shape of a request that died between the R2 write and the row.
    await env.MEDIA.put('listings/lst_soon/orphan.webp', new Uint8Array([1, 2, 3]))

    const dry = await (await SELF.fetch('https://nepscene.test/api/author/media/sweep', {
      method: 'POST', headers: { cookie },
    })).json() as any
    expect(dry).toMatchObject({ orphans: 1, deleted: 0, dry_run: true })
    expect(dry.keys).toEqual(['listings/lst_soon/orphan.webp'])
    expect(await env.MEDIA.head('listings/lst_soon/orphan.webp')).not.toBeNull()

    const swept = await (await SELF.fetch('https://nepscene.test/api/author/media/sweep?dry_run=false', {
      method: 'POST', headers: { cookie },
    })).json() as any
    expect(swept).toMatchObject({ orphans: 1, deleted: 1 })
    expect(await env.MEDIA.head('listings/lst_soon/orphan.webp')).toBeNull()
  })

  it('never sweeps an object a row still points at', async () => {
    const cookie = await signIn('s@example.np', 'admin')
    const { body } = await upload(cookie, 'lst_soon', { derivatives: LADDER })

    await SELF.fetch('https://nepscene.test/api/author/media/sweep?dry_run=false', {
      method: 'POST', headers: { cookie },
    })
    for (const url of [body.url, ...body.derivatives.map((d: any) => d.url)]) {
      expect(await env.MEDIA.head(url.replace('/api/media/', ''))).not.toBeNull()
    }
  })

  it('is an admin verb, not something any author can run', async () => {
    const cookie = await signIn('t@example.np', 'organizer')
    const response = await SELF.fetch('https://nepscene.test/api/author/media/sweep', {
      method: 'POST', headers: { cookie },
    })
    expect(response.status).toBe(403)
  })
})
