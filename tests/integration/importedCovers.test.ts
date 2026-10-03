import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seedCatalogue } from '../helpers/seed'
import { mirrorKey } from '../../api/media/imported'

/**
 * Imported covers never show where they were scraped from.
 *
 * The public API hands out a path on our origin for an imported cover, and that
 * path serves the bytes: fetched from the source once, stored in R2, read from
 * R2 after. The source URL itself appears in no public response.
 */
const SOURCE = 'https://source-site.example/uploads/2026/poster.png'

/** A valid 1200x630 PNG header — enough for the size parser to read it. */
const PNG_BYTES = (() => {
  const b = new Uint8Array(33)
  b.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  b.set([0, 0, 0, 13], 8)
  b.set([...'IHDR'].map((c) => c.charCodeAt(0)), 12)
  const view = new DataView(b.buffer)
  view.setUint32(16, 1200)
  view.setUint32(20, 630)
  return b
})()

const get = (path: string, init?: RequestInit) => SELF.fetch(`https://nepscene.test${path}`, init)

/** Answers for the source site only; anything else fetched is a test failure. */
function stubSource(respond: () => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === SOURCE) return respond()
    throw new Error(`unexpected fetch to ${url}`)
  })
}

async function coverPath(slug: string): Promise<string> {
  const body = (await (await get(`/api/catalog/listings/${slug}`)).json()) as any
  return body.cover_image_url as string
}

beforeEach(async () => {
  await seedCatalogue()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO listings
        (id, slug, title, listing_type, source, status, venue_id, starts_at,
         cover_image_url, published_at, created_at, updated_at)
       VALUES ('lst_import', 'scraped-show', 'Scraped Show', 'announcement', 'import',
               'published', 'ven_thamel', ?1, ?2, ?3, ?3, ?3)`,
    ).bind(new Date(Date.now() + 5 * 86_400_000).toISOString(), SOURCE, now),
    // An authored cover URL is its author's to publish, and is left as it is.
    env.DB.prepare(`UPDATE listings SET cover_image_url = ?1 WHERE id = 'lst_later'`)
      .bind('https://cdn.example/authored.png'),
  ])
  const listed = await env.MEDIA.list({ prefix: 'imported/' })
  await Promise.all(listed.objects.map((object) => env.MEDIA.delete(object.key)))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the public listing JSON', () => {
  it('replaces an imported cover with an opaque path on our own origin', async () => {
    const response = await get('/api/catalog/listings/scraped-show')
    const text = await response.text()
    expect(text).not.toContain('source-site.example')
    const body = JSON.parse(text)
    expect(body.cover_image_url).toMatch(/^\/api\/media\/cover\/lst_import\/[0-9a-f]{8}$/)
  })

  it('does the same in the feed, which is what the cards render', async () => {
    const text = await (await get('/api/catalog/listings?limit=50')).text()
    expect(text).not.toContain('source-site.example')
    expect(text).toContain('/api/media/cover/lst_import/')
  })

  it('leaves an authored cover URL as its author set it', async () => {
    expect(await coverPath('lakeside-live')).toBe('https://cdn.example/authored.png')
  })

  it('keeps the stored column untouched for editors', async () => {
    const row = await env.DB.prepare(`SELECT cover_image_url FROM listings WHERE id = 'lst_import'`)
      .first<{ cover_image_url: string }>()
    expect(row?.cover_image_url).toBe(SOURCE)
  })
})

describe('GET /api/media/cover/:id/:version', () => {
  it('fetches the source once, stores it in R2, and serves from R2 after', async () => {
    const spy = stubSource(() => new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }))
    const path = await coverPath('scraped-show')

    const first = await get(path)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(first.headers.get('cache-control')).toContain('immutable')
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG_BYTES)
    expect(spy).toHaveBeenCalledTimes(1)

    const stored = await env.MEDIA.get(await mirrorKey(SOURCE))
    expect(stored).not.toBeNull()
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PNG_BYTES)

    const second = await get(path)
    expect(second.status).toBe(200)
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(PNG_BYTES)
    expect(spy).toHaveBeenCalledTimes(1)

    const etag = second.headers.get('etag') ?? ''
    expect((await get(path, { headers: { 'if-none-match': etag } })).status).toBe(304)
  })

  it('sends a stale version on to the current one rather than serving it', async () => {
    const response = await get('/api/media/cover/lst_import/00000000', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(await coverPath('scraped-show'))
  })

  it('404s a listing that does not exist', async () => {
    expect((await get('/api/media/cover/lst_nonexistent/00000000')).status).toBe(404)
  })

  it('404s a listing that is not an import, so it cannot fetch an authored URL', async () => {
    const spy = stubSource(() => new Response(PNG_BYTES))
    expect((await get('/api/media/cover/lst_later/00000000')).status).toBe(404)
    expect(spy).not.toHaveBeenCalled()
  })

  it('404s an import that is not published', async () => {
    await env.DB.prepare(`UPDATE listings SET status = 'draft' WHERE id = 'lst_import'`).run()
    expect((await get('/api/media/cover/lst_import/00000000')).status).toBe(404)
  })

  it('refuses a source that answers with something other than an image', async () => {
    stubSource(() => new Response('<svg onload="alert(1)"/>', {
      headers: { 'content-type': 'image/svg+xml' },
    }))
    const response = await get(await coverPath('scraped-show'))
    expect(response.status).toBe(502)
    expect(((await response.json()) as any).error.code).toBe('cover_unavailable')
    expect(await env.MEDIA.get(await mirrorKey(SOURCE))).toBeNull()
  })

  it('refuses bytes that are not the image type they claim to be', async () => {
    stubSource(() => new Response('<html>not found</html>', {
      headers: { 'content-type': 'image/png' },
    }))
    expect((await get(await coverPath('scraped-show'))).status).toBe(502)
    expect(await env.MEDIA.get(await mirrorKey(SOURCE))).toBeNull()
  })

  it('refuses a source that declares more than the size cap', async () => {
    stubSource(() => new Response(PNG_BYTES, {
      headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) },
    }))
    expect((await get(await coverPath('scraped-show'))).status).toBe(502)
  })

  it('reports a source that is down as a missing cover, not a 500', async () => {
    stubSource(() => new Response('gone', { status: 404 }))
    expect((await get(await coverPath('scraped-show'))).status).toBe(502)
  })
})

describe('the server-rendered listing page', () => {
  // Needs the built shell, as tests/integration/rendering.test.ts does.
  it('carries the opaque path in og:image and JSON-LD, and the source nowhere', async () => {
    const response = await get('/listings/scraped-show')
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain('source-site.example')
    const ogImage = /<meta[^>]*property="og:image"[^>]*content="([^"]*)"/.exec(body)?.[1]
      ?? /<meta[^>]*content="([^"]*)"[^>]*property="og:image"/.exec(body)?.[1]
    expect(ogImage).toMatch(/^https:\/\/nepscene\.test\/api\/media\/cover\/lst_import\/[0-9a-f]{8}$/)
    expect(body).toMatch(/"image":"https:\/\/nepscene\.test\/api\/media\/cover\/lst_import\//)
  })
})
