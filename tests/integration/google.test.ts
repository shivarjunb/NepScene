import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Google sign-in's account logic (#27), exercised against a stubbed token
 * endpoint. This proves creation and linking behave correctly; it does not
 * prove Google's own flow works, which needs real credentials (#13).
 */
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'RS256' })}.${encode({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })}.signature-not-checked`
}

/** The token came from Google over TLS with our client secret, so the flow
 *  trusts it — but iss, aud and exp are still validated. */
function stubTokenEndpoint(claims: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ id_token: idToken(claims) })
    }
    throw new Error(`unexpected fetch to ${url}`)
  })
}

async function callback(cookies: string) {
  return SELF.fetch('https://nepscene.test/api/auth/google/callback?code=auth-code&state=the-state', {
    headers: { cookie: cookies },
    redirect: 'manual',
  })
}

const COOKIES = 'ns_oauth_state=the-state; ns_oauth_verifier=the-verifier; ns_oauth_return=/'

beforeEach(async () => {
  env.GOOGLE_CLIENT_ID = CLIENT_ID
  env.GOOGLE_CLIENT_SECRET = 'test-secret'
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
  env.GOOGLE_CLIENT_ID = ''
  env.GOOGLE_CLIENT_SECRET = ''
})

describe('google sign-in', () => {
  it('starts the flow with PKCE and a state cookie', async () => {
    const response = await SELF.fetch('https://nepscene.test/api/auth/google/start',
      { redirect: 'manual' })
    expect(response.status).toBe(302)

    const location = new URL(response.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)

    const cookies = response.headers.getAll('set-cookie').join(' ')
    expect(cookies).toContain('ns_oauth_state=')
    expect(cookies).toContain('ns_oauth_verifier=')
    expect(cookies).toContain('HttpOnly')
  })

  it('creates an account for a new Google user', async () => {
    stubTokenEndpoint({ sub: 'google-1', email: 'new@example.np', email_verified: true, name: 'New Person' })
    const response = await callback(COOKIES)

    expect(response.status).toBe(302)
    expect(response.headers.getAll('set-cookie').join(' ')).toContain('ns_session=')

    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1')
      .bind('new@example.np').first<any>()
    expect(user.google_sub).toBe('google-1')
    expect(user.email_verified).toBe(1)
    expect(user.name).toBe('New Person')
    expect(user.password_hash).toBeNull()
  })

  it('links to the existing account rather than creating a second one', async () => {
    await SELF.fetch('https://nepscene.test/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ email: 'both@example.np', password: 'a-decent-passphrase' }),
    })

    stubTokenEndpoint({ sub: 'google-2', email: 'both@example.np', email_verified: true, name: 'Same Person' })
    expect((await callback(COOKIES)).status).toBe(302)

    const { results } = await env.DB.prepare('SELECT id, google_sub, password_hash FROM users WHERE email = ?1')
      .bind('both@example.np').all<any>()
    // One account, now reachable both ways.
    expect(results).toHaveLength(1)
    expect(results[0].google_sub).toBe('google-2')
    expect(results[0].password_hash).not.toBeNull()
  })

  it('refuses a token issued for another application', async () => {
    stubTokenEndpoint({ sub: 'google-3', email: 'wrong@example.np', aud: 'someone-elses-client-id' })
    const response = await callback(COOKIES)
    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe('oauth_failed')
  })

  it('refuses an expired token', async () => {
    stubTokenEndpoint({ sub: 'google-4', email: 'stale@example.np', exp: Math.floor(Date.now() / 1000) - 60 })
    expect((await callback(COOKIES)).status).toBe(400)
  })

  it('refuses a mismatched state — the CSRF guard on the callback', async () => {
    stubTokenEndpoint({ sub: 'google-5', email: 'csrf@example.np' })
    const response = await callback('ns_oauth_state=a-different-state; ns_oauth_verifier=v')
    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe('oauth_state_mismatch')
  })
})
