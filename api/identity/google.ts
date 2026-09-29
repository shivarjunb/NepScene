import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest } from '../lib/http'
import { swallowed } from '../lib/observability'
import { randomToken, toBase64 } from './password'
import { createSession, sessionCookie } from './sessions'

/**
 * Google sign-in (#27) — authorization code flow with PKCE.
 *
 * The state and the PKCE verifier live in short-lived HttpOnly cookies rather
 * than in KV: they are single-use, they belong to one browser, and a store that
 * has to be cleaned up is a store that will not be.
 */
export const googleRoutes = new Hono<{ Bindings: Env }>()

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const STATE_TTL_SECONDS = 600

const STATE_COOKIE = 'ns_oauth_state'
const VERIFIER_COOKIE = 'ns_oauth_verifier'
const RETURN_COOKIE = 'ns_oauth_return'

const configured = (env: Env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)

/**
 * Whether to offer the button at all. An environment without credentials
 * (every preview, and local) would otherwise show a button that answers 500.
 */
googleRoutes.get('/status', (c) => c.json({ enabled: configured(c.env) }))

googleRoutes.get('/start', async (c) => {
  if (!configured(c.env)) {
    throw new ApiError(500, 'google_not_configured', 'Google sign-in is not configured here')
  }

  const state = randomToken(16)
  const verifier = randomToken(32)
  const returnTo = safeReturnPath(c.req.query('return_to'))

  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri(c.req.url))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', await pkceChallenge(verifier))
  url.searchParams.set('code_challenge_method', 'S256')

  const headers = new Headers({ location: url.toString() })
  headers.append('set-cookie', shortCookie(c.env, STATE_COOKIE, state))
  headers.append('set-cookie', shortCookie(c.env, VERIFIER_COOKIE, verifier))
  // Encoded: the path is attacker-writable, and a raw `;` in it would add
  // attributes to the cookie.
  headers.append('set-cookie', shortCookie(c.env, RETURN_COOKIE, encodeURIComponent(returnTo)))
  return new Response(null, { status: 302, headers })
})

/**
 * The browser arrives here from Google, not from our own fetch — so a failure
 * goes back to /login with a code the page can explain, rather than a JSON body
 * nobody would read.
 */
googleRoutes.get('/callback', async (c) => {
  const cookies = parseCookies(c.req.header('cookie'))
  const returnTo = safeReturnPath(decodeCookie(cookies[RETURN_COOKIE]))

  let user: { id: string }
  try {
    user = await completeSignIn(c.env, c.req.url, c.req.query('code'), c.req.query('state'),
      c.req.query('error'), cookies)
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    const login = new URL('/login', c.req.url)
    login.searchParams.set('google_error', error.code)
    if (returnTo !== '/') login.searchParams.set('next', returnTo)
    return redirect(`${login.pathname}${login.search}`)
  }

  const session = await createSession(c.env, user.id, c.req.header('user-agent') ?? null)
  const response = redirect(returnTo)
  response.headers.append('set-cookie', sessionCookie(c.env, session.token, session.expiresAt))
  return response
})

async function completeSignIn(
  env: Env, requestUrl: string, code: string | undefined, state: string | undefined,
  googleError: string | undefined, cookies: Record<string, string>,
): Promise<{ id: string }> {
  if (!configured(env)) {
    throw new ApiError(500, 'google_not_configured', 'Google sign-in is not configured here')
  }
  // The person pressed Cancel on Google's consent screen.
  if (googleError) throw badRequest('oauth_cancelled', 'Google sign-in was cancelled')
  if (!code) throw badRequest('oauth_failed', 'Google did not return an authorization code')
  if (!state || state !== cookies[STATE_COOKIE]) {
    throw badRequest('oauth_state_mismatch', 'That sign-in attempt has expired. Try again.')
  }
  const verifier = cookies[VERIFIER_COOKIE]
  if (!verifier) throw badRequest('oauth_state_mismatch', 'That sign-in attempt has expired. Try again.')

  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(requestUrl),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })

  if (!tokenResponse.ok) {
    throw new ApiError(400, 'oauth_failed', 'Google rejected the sign-in')
  }

  const tokens = (await tokenResponse.json()) as { id_token?: string }
  if (!tokens.id_token) throw new ApiError(400, 'oauth_failed', 'Google returned no identity token')

  const claims = readIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID)
  return upsertGoogleUser(env, claims)
}

/** Every exit clears the single-use cookies, success or not. */
function redirect(location: string): Response {
  const headers = new Headers({ location })
  for (const name of [STATE_COOKIE, VERIFIER_COOKIE, RETURN_COOKIE]) {
    headers.append('set-cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  }
  return new Response(null, { status: 302, headers })
}

type GoogleClaims = { sub: string; email: string; email_verified: boolean; name: string | null; picture: string | null }

/**
 * The token came straight from Google's token endpoint over TLS, authenticated
 * with our client secret, so its signature does not need re-verifying (Google's
 * own guidance). The claims that constrain *who* it is for still do.
 */
function readIdToken(idToken: string, clientId: string): GoogleClaims {
  const payload = idToken.split('.')[1]
  if (!payload) throw new ApiError(400, 'oauth_failed', 'Malformed identity token')

  let claims: Record<string, unknown>
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
    claims = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)))
  } catch {
    throw new ApiError(400, 'oauth_failed', 'Malformed identity token')
  }

  const issuer = String(claims.iss ?? '')
  if (issuer !== 'https://accounts.google.com' && issuer !== 'accounts.google.com') {
    throw new ApiError(400, 'oauth_failed', 'Identity token has the wrong issuer')
  }
  if (String(claims.aud ?? '') !== clientId) {
    throw new ApiError(400, 'oauth_failed', 'Identity token was issued for another application')
  }
  if (Number(claims.exp ?? 0) * 1000 < Date.now()) {
    throw new ApiError(400, 'oauth_failed', 'Identity token has expired')
  }

  const email = String(claims.email ?? '').toLowerCase()
  if (!email) throw new ApiError(400, 'oauth_failed', 'Google returned no email address')

  return {
    sub: String(claims.sub),
    email,
    email_verified: claims.email_verified === true,
    name: claims.name ? String(claims.name).slice(0, 120) : null,
    picture: claims.picture ? String(claims.picture).slice(0, 500) : null,
  }
}

type UserRow = { id: string; google_sub: string | null; is_active: number }

async function upsertGoogleUser(env: Env, claims: GoogleClaims): Promise<{ id: string }> {
  const now = new Date().toISOString()

  // The Google subject is the identity; the email is only a way to find an
  // account that has never been linked. Looked up in that order so a row that
  // holds the sub always wins over one that merely shares the address.
  const bySub = await env.DB.prepare('SELECT id, google_sub, is_active FROM users WHERE google_sub = ?1')
    .bind(claims.sub).first<UserRow>()
  const existing = bySub ?? await env.DB.prepare(
    'SELECT id, google_sub, is_active FROM users WHERE email = ?1',
  ).bind(claims.email).first<UserRow>()

  if (existing) {
    if (existing.is_active !== 1) {
      throw new ApiError(403, 'account_disabled', 'This account has been deactivated')
    }
    if (!bySub) {
      // Linking by email hands this Google account every session the existing
      // one could open — an admin's included. Only Google's word that the
      // address is theirs makes that safe; an unverified address is a claim.
      if (!claims.email_verified) {
        throw new ApiError(409, 'google_email_unverified',
          'Your Google account has not verified this email address')
      }
      // A different Google identity already holds this account.
      if (existing.google_sub) {
        throw new ApiError(409, 'google_account_mismatch',
          'This email is linked to a different Google account')
      }
    }
    await env.DB.prepare(
      `UPDATE users SET google_sub = ?1, name = COALESCE(name, ?2),
                        avatar_url = COALESCE(avatar_url, ?3),
                        email_verified = CASE WHEN ?4 = 1 THEN 1 ELSE email_verified END,
                        last_login_at = ?5, updated_at = ?5
       WHERE id = ?6`,
    ).bind(claims.sub, claims.name, claims.picture, claims.email_verified ? 1 : 0, now, existing.id)
      .run()
    return { id: existing.id }
  }

  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_verified, name, avatar_url, google_sub, role,
                        last_login_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'visitor', ?7, ?7, ?7)`,
  ).bind(id, claims.email, claims.email_verified ? 1 : 0, claims.name, claims.picture,
         claims.sub, now).run()
  return { id }
}

function redirectUri(requestUrl: string): string {
  return new URL('/api/auth/google/callback', requestUrl).toString()
}

/**
 * Only a same-site path may be returned to; an absolute URL is an open
 * redirect. Browsers read `/\host` as `//host`, so a backslash is refused too.
 */
function safeReturnPath(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  return value.slice(0, 500)
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return toBase64(new Uint8Array(digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function shortCookie(env: Env, name: string, value: string): string {
  const secure = env.ENVIRONMENT === 'local' ? '' : ' Secure;'
  return `${name}=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`
}

function decodeCookie(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return decodeURIComponent(value)
  } catch (cause) {
    // A mangled return path costs the person their place, not their sign-in.
    swallowed('google_return_cookie_undecodable', cause)
    return undefined
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header?.split(';') ?? []) {
    const [name, ...rest] = part.trim().split('=')
    if (name) out[name] = rest.join('=')
  }
  return out
}
