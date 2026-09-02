import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Each test uses its own client IP so the credential rate limiter — a shared
 * fixed window per IP — cannot make one test's attempts fail another's.
 */
let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`

const post = (path: string, body: unknown, init: RequestInit = {}) =>
  SELF.fetch(`https://nepscene.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp(), ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  })

const cookieFrom = (response: Response): string => {
  const header = response.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

async function registerUser(email: string, password = 'a-decent-passphrase') {
  const response = await post('/api/auth/register', { email, password, name: 'Test Person' })
  const body = (await response.json()) as any
  return { response, body, cookie: cookieFrom(response) }
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_tokens'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

describe('registration', () => {
  it('creates a visitor and signs them in', async () => {
    const { response, body, cookie } = await registerUser('someone@example.np')
    expect(response.status).toBe(201)
    expect(body.user.role).toBe('visitor')
    expect(body.user.email_verified).toBe(false)
    expect(cookie).toMatch(/^ns_session=/)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('never stores the password itself', async () => {
    await registerUser('stored@example.np')
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE email = ?1')
      .bind('stored@example.np').first<{ password_hash: string }>()
    expect(row!.password_hash).not.toContain('a-decent-passphrase')
    expect(row!.password_hash.startsWith('pbkdf2$sha256$')).toBe(true)
  })

  it('rejects a duplicate email, a bad address and a short password', async () => {
    await registerUser('taken@example.np')
    expect((await registerUser('taken@example.np')).response.status).toBe(409)
    expect((await post('/api/auth/register', { email: 'nope', password: 'a-decent-passphrase' })).status).toBe(400)
    expect((await post('/api/auth/register', { email: 'short@example.np', password: 'short' })).status).toBe(400)
  })

  it('treats the email case-insensitively', async () => {
    await registerUser('Mixed@Example.NP')
    expect((await registerUser('mixed@example.np')).response.status).toBe(409)
  })
})

describe('sign in and out', () => {
  it('signs in with the right password and refuses the wrong one', async () => {
    await registerUser('login@example.np')

    const wrong = await post('/api/auth/login', { email: 'login@example.np', password: 'wrong-passphrase' })
    expect(wrong.status).toBe(401)

    const right = await post('/api/auth/login', { email: 'login@example.np', password: 'a-decent-passphrase' })
    expect(right.status).toBe(200)
    expect(cookieFrom(right)).toMatch(/^ns_session=/)
  })

  it('answers identically for an unknown account, so accounts cannot be enumerated', async () => {
    await registerUser('known@example.np')
    const unknown = await post('/api/auth/login', { email: 'ghost@example.np', password: 'a-decent-passphrase' })
    const known = await post('/api/auth/login', { email: 'known@example.np', password: 'wrong-passphrase' })
    expect(unknown.status).toBe(known.status)
    expect(await unknown.json()).toEqual(await known.json())
  })

  it('stores the session cookie only as a hash', async () => {
    const { cookie } = await registerUser('hashed@example.np')
    const token = cookie.replace('ns_session=', '')
    const row = await env.DB.prepare('SELECT id FROM user_sessions LIMIT 1').first<{ id: string }>()
    expect(row!.id).not.toBe(token)
    expect(row!.id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stops accepting the cookie after logout', async () => {
    const { cookie } = await registerUser('bye@example.np')
    const headers = { cookie, 'cf-connecting-ip': nextIp() }

    expect((await SELF.fetch('https://nepscene.test/api/auth/me', { headers })).status).toBe(200)
    await SELF.fetch('https://nepscene.test/api/auth/logout', { method: 'POST', headers })
    expect((await SELF.fetch('https://nepscene.test/api/auth/me', { headers })).status).toBe(401)
  })

  it('signs out everywhere', async () => {
    const first = await registerUser('multi@example.np')
    const second = await post('/api/auth/login', { email: 'multi@example.np', password: 'a-decent-passphrase' })

    await SELF.fetch('https://nepscene.test/api/auth/sessions/revoke-all', {
      method: 'POST', headers: { cookie: first.cookie },
    })

    for (const cookie of [first.cookie, cookieFrom(second)]) {
      expect((await SELF.fetch('https://nepscene.test/api/auth/me', { headers: { cookie } })).status).toBe(401)
    }
  })

  it('rejects a forged or expired session', async () => {
    const { cookie } = await registerUser('forged@example.np')
    expect((await SELF.fetch('https://nepscene.test/api/auth/me',
      { headers: { cookie: 'ns_session=made-up-token' } })).status).toBe(401)

    await env.DB.prepare('UPDATE user_sessions SET expires_at = ?1')
      .bind(new Date(Date.now() - 1000).toISOString()).run()
    expect((await SELF.fetch('https://nepscene.test/api/auth/me', { headers: { cookie } })).status).toBe(401)
  })

  it('throttles repeated attempts from one address', async () => {
    const ip = '198.51.100.7'
    const attempt = () =>
      SELF.fetch('https://nepscene.test/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ email: 'flood@example.np', password: 'short' }),
      })

    const statuses: number[] = []
    for (let i = 0; i < 12; i++) statuses.push((await attempt()).status)
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400))
    expect(statuses.at(-1)).toBe(429)
  })
})

describe('the account itself', () => {
  it('reports who you are and what you may do', async () => {
    const { cookie } = await registerUser('who@example.np')
    const response = await SELF.fetch('https://nepscene.test/api/auth/me', { headers: { cookie } })
    const body = (await response.json()) as any
    expect(body.user.email).toBe('who@example.np')
    expect(body.permissions).toEqual([])
    // The session digest is internal; an account description does not carry it.
    expect(body.user.session_id).toBeUndefined()
  })

  it('verifies an email with its token, once', async () => {
    const { body, cookie } = await registerUser('verify@example.np')
    expect(body.email_verify_token).toBeTruthy()

    expect((await post('/api/auth/verify-email', { token: body.email_verify_token })).status).toBe(200)
    const me = await (await SELF.fetch('https://nepscene.test/api/auth/me', { headers: { cookie } })).json() as any
    expect(me.user.email_verified).toBe(true)

    // Replaying a used token must not work.
    expect((await post('/api/auth/verify-email', { token: body.email_verify_token })).status).toBe(400)
  })

  it('lets someone correct their own name, and refuses a non-https avatar', async () => {
    const { cookie } = await registerUser('edit@example.np')
    const headers = { cookie, 'content-type': 'application/json' }

    const ok = await SELF.fetch('https://nepscene.test/api/auth/me', {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'Corrected Name' }),
    })
    expect(ok.status).toBe(200)

    const bad = await SELF.fetch('https://nepscene.test/api/auth/me', {
      method: 'PATCH', headers, body: JSON.stringify({ avatar_url: 'http://insecure.example/a.png' }),
    })
    expect(bad.status).toBe(400)
  })

  it('requires a session for anything about the account', async () => {
    for (const [path, method] of [['/api/auth/me', 'GET'], ['/api/auth/me', 'PATCH'],
                                  ['/api/auth/sessions/revoke-all', 'POST']] as const) {
      const response = await SELF.fetch(`https://nepscene.test${path}`, {
        method, ...(method === 'PATCH' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })
})

describe('google sign-in', () => {
  it('refuses rather than half-working when it is not configured', async () => {
    const response = await SELF.fetch('https://nepscene.test/api/auth/google/start', { redirect: 'manual' })
    expect(response.status).toBe(500)
    expect(((await response.json()) as any).error.code).toBe('google_not_configured')
  })
})

describe('the catalogue stays anonymous', () => {
  it('does not look a session up on a public read', async () => {
    const { cookie } = await registerUser('reader@example.np')
    const response = await SELF.fetch('https://nepscene.test/api/catalog/listings?limit=4&fresh=1', {
      headers: { cookie },
    })
    // Still one round trip: the feed's own query, and no session lookup behind it.
    expect(Number(response.headers.get('x-d1-round-trips'))).toBeLessThanOrEqual(1)
  })
})
