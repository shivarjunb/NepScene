import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

/**
 * #29 — the parts of an account that come after it exists: changing an address,
 * taking a copy of what is held, and leaving without taking the community's
 * listings with you.
 */
let ipCounter = 0
const nextIp = () => `192.0.2.${(ipCounter++ % 250) + 1}`

const PASSWORD = 'a-decent-passphrase'

async function register(email: string): Promise<{ cookie: string; id: string }> {
  const response = await SELF.fetch('https://nepscene.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email)
    .first<{ id: string }>()
  return { cookie, id: row!.id }
}

const post = (path: string, cookie: string, body: unknown = {}) =>
  SELF.fetch(`https://nepscene.test${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify(body),
  })

const del = (path: string, cookie: string, body: unknown = {}) =>
  SELF.fetch(`https://nepscene.test${path}`, {
    method: 'DELETE',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const json = async (response: Response) => (await response.json()) as any

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM organization_users'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

describe('changing an email address', () => {
  it('does not take effect until the new address is verified', async () => {
    const { cookie, id } = await register('before@example.np')

    const response = await post('/api/auth/email/change', cookie, {
      email: 'after@example.np', current_password: PASSWORD,
    })
    expect(response.status).toBe(200)

    // The claim is recorded; the address the person actually controls is not
    // touched, so sign-in and password reset still work.
    const row = await env.DB.prepare('SELECT email, pending_email FROM users WHERE id = ?1')
      .bind(id).first<{ email: string; pending_email: string }>()
    expect(row).toEqual({ email: 'before@example.np', pending_email: 'after@example.np' })
  })

  it('applies it when the token from the new mailbox comes back', async () => {
    const { cookie, id } = await register('old@example.np')
    const requested = await json(await post('/api/auth/email/change', cookie, {
      email: 'new@example.np', current_password: PASSWORD,
    }))

    const confirmed = await json(await post('/api/auth/verify-email', cookie, {
      token: requested.email_verify_token,
    }))
    expect(confirmed).toMatchObject({ ok: true, email: 'new@example.np', sessions_revoked: true })

    const row = await env.DB.prepare('SELECT email, pending_email, email_verified FROM users WHERE id = ?1')
      .bind(id).first<{ email: string; pending_email: string | null; email_verified: number }>()
    expect(row).toEqual({ email: 'new@example.np', pending_email: null, email_verified: 1 })
  })

  it('signs every session out, because the reset address has just moved', async () => {
    const { cookie } = await register('moving@example.np')
    const requested = await json(await post('/api/auth/email/change', cookie, {
      email: 'moved@example.np', current_password: PASSWORD,
    }))
    await post('/api/auth/verify-email', cookie, { token: requested.email_verify_token })

    const me = await SELF.fetch('https://nepscene.test/api/auth/me', { headers: { cookie } })
    expect(me.status).toBe(401)
  })

  it('refuses without the current password', async () => {
    const { cookie } = await register('careful@example.np')
    const response = await post('/api/auth/email/change', cookie, {
      email: 'elsewhere@example.np', current_password: 'not-the-password',
    })
    expect(response.status).toBe(403)
  })

  it('refuses an address someone else already has', async () => {
    await register('taken@example.np')
    const { cookie } = await register('hopeful@example.np')
    const response = await post('/api/auth/email/change', cookie, {
      email: 'taken@example.np', current_password: PASSWORD,
    })
    expect(response.status).toBe(400)
    expect((await json(response)).error.code).toBe('email_taken')
  })

  it('voids an earlier request when a second one is made', async () => {
    const { cookie } = await register('indecisive@example.np')
    const first = await json(await post('/api/auth/email/change', cookie, {
      email: 'one@example.np', current_password: PASSWORD,
    }))
    await post('/api/auth/email/change', cookie, {
      email: 'two@example.np', current_password: PASSWORD,
    })

    // Otherwise the older link, sent to a different mailbox, still works.
    const response = await post('/api/auth/verify-email', cookie, { token: first.email_verify_token })
    expect(response.status).toBe(400)
  })

  it('shows the pending address on the account', async () => {
    const { cookie } = await register('waiting@example.np')
    await post('/api/auth/email/change', cookie, {
      email: 'soon@example.np', current_password: PASSWORD,
    })
    const me = await json(await SELF.fetch('https://nepscene.test/api/auth/me', { headers: { cookie } }))
    expect(me.user.pending_email).toBe('soon@example.np')
  })

  it('still verifies a plain registration, with no address to move', async () => {
    const { cookie, id } = await register('plain@example.np')
    const token = 'plain-verification-token'
    // The registration flow's own token, with nothing pending behind it.
    await env.DB.prepare(
      `INSERT INTO user_tokens (id, user_id, kind, token_hash, expires_at, created_at)
       VALUES (?1, ?2, 'email_verify', ?3, ?4, ?5)`,
    ).bind(crypto.randomUUID(), id, await sha256(token),
           new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString()).run()

    const response = await json(await post('/api/auth/verify-email', cookie, { token }))
    expect(response).toEqual({ ok: true })
    const row = await env.DB.prepare('SELECT email, email_verified FROM users WHERE id = ?1')
      .bind(id).first<{ email: string; email_verified: number }>()
    expect(row).toEqual({ email: 'plain@example.np', email_verified: 1 })
  })
})

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('exporting an account', () => {
  it('returns what is held, under the names it is held under', async () => {
    const { cookie, id } = await register('curious@example.np')
    await env.DB.prepare('UPDATE listings SET created_by = ?1 WHERE id = ?2')
      .bind(id, 'lst_soon').run()

    const response = await SELF.fetch('https://nepscene.test/api/auth/me/export', {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('attachment')

    const body = await json(response)
    expect(body.account).toMatchObject({ id, email: 'curious@example.np', role: 'visitor' })
    expect(body.sessions).toHaveLength(1)
    expect(body.listings.map((l: any) => l.slug)).toEqual(['rock-night'])
    expect(body).toHaveProperty('organizations')
    expect(body).toHaveProperty('media')
    expect(body).toHaveProperty('audit_log')
  })

  it('never includes the password digest', async () => {
    // An export that carries a credential is an offline cracking target.
    const { cookie } = await register('cautious@example.np')
    const body = await json(await SELF.fetch('https://nepscene.test/api/auth/me/export', {
      headers: { cookie },
    }))
    expect(JSON.stringify(body)).not.toContain('password_hash')
    expect(body.account.has_password).toBe(1)
  })

  it('needs a session', async () => {
    const response = await SELF.fetch('https://nepscene.test/api/auth/me/export')
    expect(response.status).toBe(401)
  })
})

describe('deleting an account', () => {
  async function authorOf(email: string, listingIds: string[]): Promise<{ cookie: string; id: string }> {
    const account = await register(email)
    for (const listingId of listingIds) {
      await env.DB.prepare('UPDATE listings SET created_by = ?1 WHERE id = ?2')
        .bind(account.id, listingId).run()
    }
    return account
  }

  it('removes the person', async () => {
    const { cookie, id } = await register('leaving@example.np')
    const response = await del('/api/auth/me', cookie, { current_password: PASSWORD })
    expect(response.status).toBe(200)

    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM user_sessions WHERE user_id = ?1').bind(id).first())
      .toBeNull()
  })

  it('keeps published listings, without an owner rather than without a listing', async () => {
    // The whole point: deleting an organizer must not quietly remove the events
    // people have already linked to and are planning to attend.
    const { cookie, id } = await authorOf('organizer@example.np', ['lst_soon', 'lst_later'])

    const body = await json(await del('/api/auth/me', cookie, { current_password: PASSWORD }))
    expect(body.listings_transferred).toBe(2)

    const rows = await env.DB.prepare(
      `SELECT id, status, created_by FROM listings WHERE id IN ('lst_soon', 'lst_later')`,
    ).all<{ id: string; status: string; created_by: string | null }>()
    expect(rows.results).toHaveLength(2)
    for (const row of rows.results) {
      expect(row.status).toBe('published')
      expect(row.created_by).toBeNull()
    }
    expect(await env.DB.prepare('SELECT id FROM listings WHERE created_by = ?1').bind(id).first())
      .toBeNull()
  })

  it('takes unpublished work with them', async () => {
    // A draft is the person's own unfinished writing, not the catalogue's.
    const { cookie } = await authorOf('writer@example.np', ['lst_draft', 'lst_pending', 'lst_soon'])

    await del('/api/auth/me', cookie, { current_password: PASSWORD })

    const surviving = await env.DB.prepare(
      `SELECT id FROM listings WHERE id IN ('lst_draft', 'lst_pending', 'lst_soon')`,
    ).all<{ id: string }>()
    expect(surviving.results.map((r) => r.id)).toEqual(['lst_soon'])
  })

  it('deletes the images of the drafts it deletes', async () => {
    const { cookie, id } = await register('photographer@example.np')
    await env.DB.prepare('UPDATE listings SET created_by = ?1 WHERE id = ?2')
      .bind(id, 'lst_draft').run()
    await env.MEDIA.put('listings/lst_draft/abc.png', new Uint8Array([1, 2, 3]))
    await env.DB.prepare(
      `INSERT INTO listing_media (id, listing_id, r2_key, mime_type, alt_text, created_at)
       VALUES ('med_draft', 'lst_draft', 'listings/lst_draft/abc.png', 'image/png', 'x', ?1)`,
    ).bind(new Date().toISOString()).run()

    const body = await json(await del('/api/auth/me', cookie, { current_password: PASSWORD }))
    expect(body.media_objects_deleted).toBe(1)
    expect(await env.MEDIA.head('listings/lst_draft/abc.png')).toBeNull()
  })

  it('keeps the history and loses the actor', async () => {
    const { cookie, id } = await register('audited@example.np')
    await env.DB.prepare(
      `INSERT INTO audit_log (id, entity_type, entity_id, action, actor_id, actor_role, created_at)
       VALUES ('aud_1', 'listing', 'lst_soon', 'published', ?1, 'editor', ?2)`,
    ).bind(id, new Date().toISOString()).run()

    await del('/api/auth/me', cookie, { current_password: PASSWORD })

    const row = await env.DB.prepare('SELECT actor_id, actor_role, action FROM audit_log WHERE id = ?1')
      .bind('aud_1').first<{ actor_id: string | null; actor_role: string; action: string }>()
    expect(row).toMatchObject({ actor_id: null, actor_role: 'editor', action: 'published' })
  })

  it('refuses without the current password, because a session is not consent', async () => {
    const { cookie, id } = await register('stolen@example.np')
    const response = await del('/api/auth/me', cookie, { current_password: 'guessing' })
    expect(response.status).toBe(403)
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()).not.toBeNull()
  })

  it('asks a Google-only account to type its own address instead', async () => {
    const { cookie, id } = await register('google@example.np')
    await env.DB.prepare('UPDATE users SET password_hash = NULL, google_sub = ?1 WHERE id = ?2')
      .bind('sub-123', id).run()

    const refused = await del('/api/auth/me', cookie, {})
    expect(refused.status).toBe(400)
    expect((await json(refused)).error.code).toBe('confirmation_required')

    const accepted = await del('/api/auth/me', cookie, { confirm_email: 'google@example.np' })
    expect(accepted.status).toBe(200)
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()).toBeNull()
  })

  it('needs a session', async () => {
    const response = await SELF.fetch('https://nepscene.test/api/auth/me', { method: 'DELETE' })
    expect(response.status).toBe(401)
  })
})
