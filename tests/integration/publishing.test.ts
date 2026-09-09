import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

let ipCounter = 0
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`

async function signIn(email: string, role: 'visitor' | 'organizer' | 'editor' | 'admin') {
  const response = await SELF.fetch('https://nepscene.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email, password: 'a-decent-passphrase' }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  await env.DB.prepare('UPDATE users SET role = ?1 WHERE email = ?2').bind(role, email).run()
  const { id } = (await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email)
    .first<{ id: string }>())!
  return { cookie, id }
}

const act = (cookie: string, id: string, verb: string, body?: Record<string, unknown>) =>
  SELF.fetch(`https://nepscene.test/api/author/listings/${id}/${verb}`, {
    method: 'POST',
    headers: body ? { cookie, 'content-type': 'application/json' } : { cookie },
    body: body ? JSON.stringify(body) : undefined,
  })

/** A rejection has to say why (#33), so every rejection here carries one. */
const REASON = 'The date is wrong — this is next month, not this one.'

const statusOf = async (id: string) =>
  (await env.DB.prepare('SELECT status FROM listings WHERE id = ?1').bind(id)
    .first<{ status: string }>())?.status

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM organization_users'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

describe('publication workflow', () => {
  it('refuses to let a draft skip review', async () => {
    const { cookie } = await signIn('editor@example.np', 'editor')
    const response = await act(cookie, 'lst_draft', 'publish')

    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe('invalid_transition')
    expect(await statusOf('lst_draft')).toBe('draft')
  })

  it('walks the legal path: draft to review to published', async () => {
    const { cookie } = await signIn('editor2@example.np', 'editor')

    expect((await act(cookie, 'lst_draft', 'submit')).status).toBe(200)
    expect(await statusOf('lst_draft')).toBe('pending_review')

    expect((await act(cookie, 'lst_draft', 'publish')).status).toBe(200)
    expect(await statusOf('lst_draft')).toBe('published')

    const row = await env.DB.prepare('SELECT published_at FROM listings WHERE id = ?1')
      .bind('lst_draft').first<{ published_at: string | null }>()
    expect(row!.published_at).toBeTruthy()
  })

  it('lets an editor reject a submission, with the reason on the row', async () => {
    const { cookie } = await signIn('editor3@example.np', 'editor')
    expect((await act(cookie, 'lst_pending', 'reject', { reason: REASON })).status).toBe(200)
    expect(await statusOf('lst_pending')).toBe('rejected')

    // Denormalised onto the listing, not left in the audit log's JSON: the
    // author has to be shown it on every load of their own listing (#33).
    const row = await env.DB.prepare('SELECT rejection_reason FROM listings WHERE id = ?1')
      .bind('lst_pending').first<{ rejection_reason: string | null }>()
    expect(row!.rejection_reason).toBe(REASON)
  })

  it('refuses a rejection that does not say why', async () => {
    const { cookie } = await signIn('editor-silent@example.np', 'editor')

    for (const body of [undefined, {}, { reason: '   ' }, { reason: 'no' }]) {
      const response = await act(cookie, 'lst_pending', 'reject', body)
      expect(response.status).toBe(400)
      expect(((await response.json()) as any).error.code).toBe('reason_required')
    }
    // Refused, not merely unrecorded: an author told nothing cannot resubmit.
    expect(await statusOf('lst_pending')).toBe('pending_review')
  })

  it('clears the reason when the author resubmits', async () => {
    const { cookie } = await signIn('editor-cycle@example.np', 'editor')
    await act(cookie, 'lst_pending', 'reject', { reason: REASON })
    await act(cookie, 'lst_pending', 'submit')

    // The author needs to know what to fix now. The old argument stays in the
    // audit log, which is where history belongs.
    const row = await env.DB.prepare('SELECT rejection_reason FROM listings WHERE id = ?1')
      .bind('lst_pending').first<{ rejection_reason: string | null }>()
    expect(row!.rejection_reason).toBeNull()
  })

  it('will not let an organizer publish their own work', async () => {
    const { cookie, id } = await signIn('organizer@example.np', 'organizer')
    await env.DB.prepare('UPDATE listings SET created_by = ?1 WHERE id = ?2')
      .bind(id, 'lst_draft').run()

    // They may submit it for review…
    expect((await act(cookie, 'lst_draft', 'submit')).status).toBe(200)
    // …but publishing is an editor's decision.
    expect((await act(cookie, 'lst_draft', 'publish')).status).toBe(403)
    expect(await statusOf('lst_draft')).toBe('pending_review')
  })

  it('makes a published listing visible and an unpublished one disappear', async () => {
    const { cookie } = await signIn('editor4@example.np', 'editor')
    await act(cookie, 'lst_draft', 'submit')
    await act(cookie, 'lst_draft', 'publish')

    const visible = await (await SELF.fetch(
      'https://nepscene.test/api/catalog/listings?limit=50&v=1')).json() as any
    expect(visible.data.map((l: any) => l.slug)).toContain('secret-draft')

    // Publishing bumps the cache version, so the next read is not a stale hit.
    expect((await act(cookie, 'lst_draft', 'unpublish')).status).toBe(200)
    const after = await (await SELF.fetch(
      'https://nepscene.test/api/catalog/listings?limit=50&v=1')).json() as any
    expect(after.data.map((l: any) => l.slug)).not.toContain('secret-draft')
  })

  it('records every transition with actor and timestamp', async () => {
    const { cookie, id } = await signIn('editor5@example.np', 'editor')
    await act(cookie, 'lst_draft', 'submit')
    await act(cookie, 'lst_draft', 'publish')

    const { results } = await env.DB.prepare(
      `SELECT action, actor_id, actor_role, details, created_at FROM audit_log
        WHERE entity_type = 'listing' AND entity_id = ?1 ORDER BY created_at`,
    ).bind('lst_draft').all<any>()

    expect(results.map((r) => r.action)).toEqual(['submitted_for_review', 'published'])
    expect(results.every((r) => r.actor_id === id)).toBe(true)
    expect(results.every((r) => r.actor_role === 'editor')).toBe(true)
    expect(results.every((r) => typeof r.created_at === 'string')).toBe(true)
    expect(JSON.parse(results[1].details)).toEqual({ from: 'pending_review', to: 'published' })
  })

  it('refuses a transition to the state it is already in', async () => {
    const { cookie } = await signIn('editor6@example.np', 'editor')
    const response = await act(cookie, 'lst_soon', 'publish')
    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe('already_in_state')
  })

  it('requires a session', async () => {
    const response = await SELF.fetch(
      'https://nepscene.test/api/author/listings/lst_draft/publish', { method: 'POST' })
    expect(response.status).toBe(401)
  })
})

describe('deleting a listing', () => {
  it('removes its R2 objects rather than orphaning them', async () => {
    const { cookie } = await signIn('editor7@example.np', 'editor')

    const png = new Uint8Array(33)
    png.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
    png.set([0, 0, 0, 13], 8)
    png.set([...'IHDR'].map((c) => c.charCodeAt(0)), 12)
    new DataView(png.buffer).setUint32(16, 1200)
    new DataView(png.buffer).setUint32(20, 630)

    const form = new FormData()
    form.set('file', new File([png], 'a.png', { type: 'image/png' }))
    form.set('alt_text', 'Poster')
    const uploaded = await (await SELF.fetch(
      'https://nepscene.test/api/author/listings/lst_soon/media',
      { method: 'POST', headers: { cookie }, body: form })).json() as any

    // The key is content-addressed now, so it comes back rather than being
    // reconstructed from an id (#25).
    const key = uploaded.url.replace('/api/media/', '')
    expect(await env.MEDIA.head(key)).not.toBeNull()

    const response = await SELF.fetch('https://nepscene.test/api/author/listings/lst_soon', {
      method: 'DELETE', headers: { cookie },
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as any).deleted_media).toBe(1)

    // The row is gone with the listing, and so are the bytes.
    expect(await env.DB.prepare('SELECT id FROM listings WHERE id = ?1').bind('lst_soon').first())
      .toBeNull()
    expect(await env.MEDIA.head(key)).toBeNull()
  })

  it('refuses someone else’s listing', async () => {
    const { cookie } = await signIn('outsider@example.np', 'organizer')
    const response = await SELF.fetch('https://nepscene.test/api/author/listings/lst_soon', {
      method: 'DELETE', headers: { cookie },
    })
    expect(response.status).toBe(403)
  })
})
