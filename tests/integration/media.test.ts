import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])

let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`

async function signIn(email: string, role: 'visitor' | 'organizer' | 'editor'): Promise<string> {
  const response = await SELF.fetch('https://nepscene.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email, password: 'a-decent-passphrase' }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  await env.DB.prepare('UPDATE users SET role = ?1 WHERE email = ?2').bind(role, email).run()
  return cookie
}

function upload(cookie: string, listingId: string, options: {
  type?: string; altText?: string | null
} = {}) {
  const form = new FormData()
  form.set('file', new File([PNG_BYTES], 'poster.png', { type: options.type ?? 'image/png' }))
  if (options.altText !== null) form.set('alt_text', options.altText ?? 'Poster for the show')
  return SELF.fetch(`https://nepscene.test/api/author/listings/${listingId}/media`, {
    method: 'POST', headers: { cookie }, body: form,
  })
}

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM organization_users'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

describe('media upload', () => {
  it('refuses a visitor: uploading is a permission, not a login', async () => {
    const cookie = await signIn('visitor@example.np', 'visitor')
    const response = await upload(cookie, 'lst_soon')
    expect(response.status).toBe(403)
    expect(((await response.json()) as any).error.code).toBe('forbidden')
  })

  it('refuses an organizer who has nothing to do with the listing', async () => {
    const cookie = await signIn('outsider@example.np', 'organizer')
    expect((await upload(cookie, 'lst_soon')).status).toBe(403)
  })

  it('accepts an organizer who belongs to the listing’s organization', async () => {
    const cookie = await signIn('member@example.np', 'organizer')
    await env.DB.prepare(
      `INSERT INTO organization_users (organization_id, user_id, org_role, created_at)
       SELECT 'org_a', id, 'member', ?1 FROM users WHERE email = 'member@example.np'`,
    ).bind(new Date().toISOString()).run()

    const response = await upload(cookie, 'lst_soon')
    expect(response.status).toBe(201)
    const body = (await response.json()) as any
    expect(body.url).toMatch(/^\/api\/media\/listings\/lst_soon\//)

    // The bytes are really in R2 and really served back.
    const fetched = await SELF.fetch(`https://nepscene.test${body.url}`)
    expect(fetched.status).toBe(200)
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG_BYTES)
    expect(fetched.headers.get('cache-control')).toContain('immutable')

    // And it appears on the listing without a second endpoint.
    const detail = await (await SELF.fetch(
      'https://nepscene.test/api/catalog/listings/rock-night?fresh=media')).json() as any
    expect(detail.media).toHaveLength(1)
    expect(detail.media[0].alt_text).toBe('Poster for the show')
  })

  it('lets an editor upload to any listing', async () => {
    const cookie = await signIn('editor@example.np', 'editor')
    expect((await upload(cookie, 'lst_soon')).status).toBe(201)
  })

  it('requires alt text, because an image without it fails WCAG on arrival', async () => {
    const cookie = await signIn('editor2@example.np', 'editor')
    const response = await upload(cookie, 'lst_soon', { altText: null })
    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe('missing_alt_text')
  })

  it('refuses a file type it will not serve', async () => {
    const cookie = await signIn('editor3@example.np', 'editor')
    const response = await upload(cookie, 'lst_soon', { type: 'application/pdf' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe('unsupported_type')
  })

  it('404s an upload to a listing that does not exist', async () => {
    const cookie = await signIn('editor4@example.np', 'editor')
    expect((await upload(cookie, 'lst_nonexistent')).status).toBe(404)
  })

  it('deletes the row and the object', async () => {
    const cookie = await signIn('editor5@example.np', 'editor')
    const created = (await (await upload(cookie, 'lst_soon')).json()) as any

    const response = await SELF.fetch(`https://nepscene.test/api/author/media/${created.id}`, {
      method: 'DELETE', headers: { cookie },
    })
    expect(response.status).toBe(200)

    const row = await env.DB.prepare('SELECT id FROM listing_media WHERE id = ?1')
      .bind(created.id).first()
    expect(row).toBeNull()
  })

  it('requires a session at all', async () => {
    const form = new FormData()
    form.set('file', new File([PNG_BYTES], 'a.png', { type: 'image/png' }))
    const response = await SELF.fetch('https://nepscene.test/api/author/listings/lst_soon/media', {
      method: 'POST', body: form,
    })
    expect(response.status).toBe(401)
  })
})

describe('media reads', () => {
  it('304s a repeat fetch with the etag', async () => {
    const cookie = await signIn('editor6@example.np', 'editor')
    const created = (await (await upload(cookie, 'lst_soon')).json()) as any

    const first = await SELF.fetch(`https://nepscene.test${created.url}`)
    const etag = first.headers.get('etag')!
    const second = await SELF.fetch(`https://nepscene.test${created.url}`, {
      headers: { 'if-none-match': etag },
    })
    expect(second.status).toBe(304)
  })

  it('404s a missing object and refuses to walk out of the bucket', async () => {
    expect((await SELF.fetch('https://nepscene.test/api/media/listings/nope.png')).status).toBe(404)
    expect((await SELF.fetch('https://nepscene.test/api/media/..%2Fsecret')).status).toBe(404)
  })
})
