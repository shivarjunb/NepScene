import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

let ipCounter = 0
const nextIp = () => `192.0.2.${(ipCounter++ % 250) + 1}`

const post = (path: string, body: unknown, cookie?: string) =>
  SELF.fetch(`https://nepscene.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': nextIp(),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })

async function register(email: string, password = 'a-decent-passphrase') {
  const response = await post('/api/auth/register', { email, password })
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

const signedIn = async (cookie: string) =>
  (await SELF.fetch('https://nepscene.test/api/auth/me', { headers: { cookie } })).status === 200

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_tokens'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

describe('password reset', () => {
  it('resets with the emailed token and invalidates every session', async () => {
    const cookie = await register('reset@example.np')
    expect(await signedIn(cookie)).toBe(true)

    const forgot = await (await post('/api/auth/password/forgot', { email: 'reset@example.np' })).json() as any
    expect(forgot.password_reset_token).toBeTruthy()

    expect((await post('/api/auth/password/reset',
      { token: forgot.password_reset_token, password: 'a-brand-new-passphrase' })).status).toBe(200)

    // Old sessions die with the old password — that is the point of a reset.
    expect(await signedIn(cookie)).toBe(false)

    expect((await post('/api/auth/login',
      { email: 'reset@example.np', password: 'a-decent-passphrase' })).status).toBe(401)
    expect((await post('/api/auth/login',
      { email: 'reset@example.np', password: 'a-brand-new-passphrase' })).status).toBe(200)
  })

  it('answers the same for an address with no account', async () => {
    const known = await post('/api/auth/password/forgot', { email: 'nobody@example.np' })
    expect(known.status).toBe(200)
    expect((await known.json() as any).password_reset_token).toBeUndefined()
  })

  it('rejects a replayed, unknown or expired token', async () => {
    await register('replay@example.np')
    const forgot = await (await post('/api/auth/password/forgot', { email: 'replay@example.np' })).json() as any

    expect((await post('/api/auth/password/reset',
      { token: forgot.password_reset_token, password: 'first-new-passphrase' })).status).toBe(200)
    expect((await post('/api/auth/password/reset',
      { token: forgot.password_reset_token, password: 'second-new-passphrase' })).status).toBe(400)
    expect((await post('/api/auth/password/reset',
      { token: 'made-up', password: 'another-passphrase' })).status).toBe(400)
  })

  it('voids an earlier reset when a new one is requested', async () => {
    await register('twice@example.np')
    const first = await (await post('/api/auth/password/forgot', { email: 'twice@example.np' })).json() as any
    const second = await (await post('/api/auth/password/forgot', { email: 'twice@example.np' })).json() as any

    expect((await post('/api/auth/password/reset',
      { token: first.password_reset_token, password: 'from-the-old-link' })).status).toBe(400)
    expect((await post('/api/auth/password/reset',
      { token: second.password_reset_token, password: 'from-the-new-link' })).status).toBe(200)
  })

  it('will not accept a weak new password', async () => {
    await register('weak@example.np')
    const forgot = await (await post('/api/auth/password/forgot', { email: 'weak@example.np' })).json() as any
    expect((await post('/api/auth/password/reset',
      { token: forgot.password_reset_token, password: 'short' })).status).toBe(400)
  })
})

describe('password change', () => {
  it('requires the current password and revokes other sessions', async () => {
    const first = await register('change@example.np')
    const secondLogin = await post('/api/auth/login',
      { email: 'change@example.np', password: 'a-decent-passphrase' })
    const second = (secondLogin.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

    expect((await post('/api/auth/password/change',
      { current_password: 'wrong-passphrase', new_password: 'a-new-passphrase' }, first)).status).toBe(403)

    expect((await post('/api/auth/password/change',
      { current_password: 'a-decent-passphrase', new_password: 'a-new-passphrase' }, first)).status).toBe(200)

    // Both sessions go, including the one that made the change.
    expect(await signedIn(first)).toBe(false)
    expect(await signedIn(second)).toBe(false)
    expect((await post('/api/auth/login',
      { email: 'change@example.np', password: 'a-new-passphrase' })).status).toBe(200)
  })

  it('records the change without recording the password', async () => {
    const cookie = await register('audited@example.np')
    await post('/api/auth/password/change',
      { current_password: 'a-decent-passphrase', new_password: 'a-new-passphrase' }, cookie)

    const row = await env.DB.prepare(
      "SELECT action, details FROM audit_log WHERE action = 'password_changed'").first<any>()
    expect(row).not.toBeNull()
    expect(JSON.stringify(row)).not.toContain('passphrase')
  })

  it('needs a session', async () => {
    expect((await post('/api/auth/password/change',
      { current_password: 'x', new_password: 'a-new-passphrase' })).status).toBe(401)
  })
})

describe('role administration', () => {
  const roleOf = async (email: string) =>
    (await env.DB.prepare('SELECT role FROM users WHERE email = ?1').bind(email)
      .first<{ role: string }>())?.role

  async function admin() {
    const cookie = await register('admin@example.np')
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE email = 'admin@example.np'").run()
    return cookie
  }

  const userId = async (email: string) =>
    (await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email)
      .first<{ id: string }>())!.id

  const setRole = (cookie: string, id: string, role: string) =>
    SELF.fetch(`https://nepscene.test/api/auth/users/${id}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ role }),
    })

  it('promotes a visitor and records who did it', async () => {
    const cookie = await admin()
    await register('promoted@example.np')
    const id = await userId('promoted@example.np')

    const response = await setRole(cookie, id, 'editor')
    expect(response.status).toBe(200)
    expect(await roleOf('promoted@example.np')).toBe('editor')

    const row = await env.DB.prepare(
      "SELECT actor_id, actor_role, details FROM audit_log WHERE action = 'role_changed'")
      .first<any>()
    expect(row.actor_id).toBe(await userId('admin@example.np'))
    expect(row.actor_role).toBe('admin')
    expect(JSON.parse(row.details)).toEqual({ from: 'visitor', to: 'editor' })
  })

  it('takes effect on the very next request, without waiting for a new session', async () => {
    const cookie = await admin()
    const subjectCookie = await register('immediate@example.np')
    const id = await userId('immediate@example.np')

    const before = await (await SELF.fetch('https://nepscene.test/api/auth/me',
      { headers: { cookie: subjectCookie } })).json() as any
    expect(before.permissions).toEqual([])

    await setRole(cookie, id, 'editor')

    const after = await (await SELF.fetch('https://nepscene.test/api/auth/me',
      { headers: { cookie: subjectCookie } })).json() as any
    expect(after.user.role).toBe('editor')
    expect(after.permissions).toContain('listing:publish')

    // And removing it revokes the ability just as immediately.
    await setRole(cookie, id, 'visitor')
    const revoked = await (await SELF.fetch('https://nepscene.test/api/auth/me',
      { headers: { cookie: subjectCookie } })).json() as any
    expect(revoked.permissions).toEqual([])
  })

  it('refuses a non-admin, an unknown role and an unknown user', async () => {
    const cookie = await admin()
    const id = await userId('admin@example.np')

    const visitorCookie = await register('nosy@example.np')
    expect((await setRole(visitorCookie, id, 'admin')).status).toBe(403)
    expect((await setRole(cookie, id, 'overlord')).status).toBe(400)
    expect((await setRole(cookie, 'no-such-user', 'editor')).status).toBe(404)
  })

  it('will not let an admin change their own role', async () => {
    const cookie = await admin()
    const response = await setRole(cookie, await userId('admin@example.np'), 'visitor')
    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe('cannot_change_own_role')
  })
})
