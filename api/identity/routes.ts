import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest } from '../lib/http'
import { hashPassword, randomToken, sha256Hex, verifyPassword } from './password'
import { permissionsFor } from './roles'
import { rateLimit } from './rateLimit'
import { requireAuth, type AuthVariables } from './middleware'
import {
  clearedSessionCookie, createSession, readSessionCookie, revokeAllSessions,
  revokeSession, sessionCookie,
} from './sessions'

export const identityRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const MIN_PASSWORD_LENGTH = 10
const EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

type Body = Record<string, unknown>

async function readJson(request: Request): Promise<Body> {
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object') throw new Error('not an object')
    return body as Body
  } catch {
    throw badRequest('invalid_body', 'Send a JSON object')
  }
}

function requireEmail(body: Body): string {
  const email = String(body.email ?? '').trim().toLowerCase()
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw badRequest('invalid_email', 'That does not look like an email address')
  }
  return email
}

function requirePassword(body: Body): string {
  const password = String(body.password ?? '')
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest('weak_password', `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (password.length > 200) throw badRequest('invalid_password', 'That password is too long')
  return password
}

async function throttle(
  c: { env: Env; req: { header(name: string): string | undefined } },
  bucket: string,
  limit: number,
) {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  const result = await rateLimit(c.env, `${bucket}:${ip}`, { limit, windowSeconds: 900 })
  if (!result.allowed) {
    throw new ApiError(429, 'rate_limited', `Too many attempts. Try again in ${result.retryAfterSeconds}s`)
  }
}

// ─── POST /api/auth/register ─────────────────────────────────────────────────
identityRoutes.post('/register', async (c) => {
  await throttle(c, 'register', 10)
  const body = await readJson(c.req.raw)
  const email = requireEmail(body)
  const password = requirePassword(body)
  const name = String(body.name ?? '').trim().slice(0, 120) || null

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?1')
    .bind(email).first<{ id: string }>()
  if (existing) throw new ApiError(409, 'email_taken', 'That email already has an account')

  const now = new Date().toISOString()
  const userId = crypto.randomUUID()
  const verifyToken = randomToken()

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'visitor', ?5, ?5)`,
    ).bind(userId, email, name, await hashPassword(password), now),
    c.env.DB.prepare(
      `INSERT INTO user_tokens (id, user_id, kind, token_hash, expires_at, created_at)
       VALUES (?1, ?2, 'email_verify', ?3, ?4, ?5)`,
    ).bind(
      crypto.randomUUID(), userId, await sha256Hex(verifyToken),
      new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString(), now,
    ),
  ])

  const session = await createSession(c.env, userId, c.req.header('user-agent') ?? null)
  c.header('set-cookie', sessionCookie(c.env, session.token, session.expiresAt))

  return c.json(
    {
      user: { id: userId, email, name, role: 'visitor', email_verified: false },
      // Email delivery is deliberately deferred (docs/BACKLOG.md), so outside
      // production the token is returned to make the flow testable. It must
      // never be in a production response body.
      ...(c.env.ENVIRONMENT === 'production' ? {} : { email_verify_token: verifyToken }),
    },
    201,
  )
})

// ─── POST /api/auth/login ────────────────────────────────────────────────────
identityRoutes.post('/login', async (c) => {
  await throttle(c, 'login', 20)
  const body = await readJson(c.req.raw)
  const email = requireEmail(body)
  const password = String(body.password ?? '')

  const user = await c.env.DB.prepare(
    'SELECT id, password_hash, is_active FROM users WHERE email = ?1',
  ).bind(email).first<{ id: string; password_hash: string | null; is_active: number }>()

  // Same error and roughly the same work whether the account exists or not:
  // a different response here enumerates who has an account.
  const stored = user?.password_hash ?? 'pbkdf2$sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'
  const ok = await verifyPassword(password, stored)
  if (!user || !ok || user.is_active !== 1) {
    throw new ApiError(401, 'invalid_credentials', 'Email or password is wrong')
  }

  const session = await createSession(c.env, user.id, c.req.header('user-agent') ?? null)
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE users SET last_login_at = ?1 WHERE id = ?2')
      .bind(new Date().toISOString(), user.id).run(),
  )
  c.header('set-cookie', sessionCookie(c.env, session.token, session.expiresAt))
  return c.json({ ok: true })
})

// ─── POST /api/auth/logout ───────────────────────────────────────────────────
identityRoutes.post('/logout', async (c) => {
  const token = readSessionCookie(c.req.header('cookie'))
  if (token) await revokeSession(c.env, await sha256Hex(token))
  c.header('set-cookie', clearedSessionCookie(c.env))
  return c.json({ ok: true })
})

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
identityRoutes.get('/me', requireAuth, (c) => {
  // session_id is the digest of the caller's cookie — internal, and not part of
  // what an account tells you about itself.
  const { session_id: _session, ...user } = c.get('user')
  return c.json({ user, permissions: permissionsFor(user.role) })
})

// ─── PATCH /api/auth/me ──────────────────────────────────────────────────────
// Account management (#29) is a decision in the backlog; this is the part that
// is not — a person can correct their own name and avatar.
identityRoutes.patch('/me', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await readJson(c.req.raw)

  const name = body.name === undefined ? undefined : String(body.name).trim().slice(0, 120)
  const avatarUrl = body.avatar_url === undefined ? undefined : String(body.avatar_url).slice(0, 500)
  if (name === undefined && avatarUrl === undefined) {
    throw badRequest('nothing_to_update', 'Send name or avatar_url')
  }
  if (avatarUrl !== undefined && avatarUrl !== '' && !avatarUrl.startsWith('https://')) {
    throw badRequest('invalid_avatar', 'avatar_url must be https')
  }

  await c.env.DB.prepare(
    `UPDATE users SET name = COALESCE(?1, name), avatar_url = COALESCE(?2, avatar_url),
                      updated_at = ?3
     WHERE id = ?4`,
  ).bind(name ?? null, avatarUrl ?? null, new Date().toISOString(), user.id).run()

  return c.json({ ok: true })
})

// ─── POST /api/auth/sessions/revoke-all ──────────────────────────────────────
identityRoutes.post('/sessions/revoke-all', requireAuth, async (c) => {
  const revoked = await revokeAllSessions(c.env, c.get('user').id)
  c.header('set-cookie', clearedSessionCookie(c.env))
  return c.json({ ok: true, revoked })
})

// ─── POST /api/auth/verify-email ─────────────────────────────────────────────
identityRoutes.post('/verify-email', async (c) => {
  await throttle(c, 'verify', 20)
  const body = await readJson(c.req.raw)
  const token = String(body.token ?? '')
  if (!token) throw badRequest('invalid_token', 'Send the token from the email')

  const now = new Date().toISOString()
  const row = await c.env.DB.prepare(
    `SELECT id, user_id FROM user_tokens
     WHERE token_hash = ?1 AND kind = 'email_verify' AND used_at IS NULL AND expires_at > ?2`,
  ).bind(await sha256Hex(token), now).first<{ id: string; user_id: string }>()

  if (!row) throw badRequest('invalid_token', 'That link has expired or was already used')

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE user_tokens SET used_at = ?1 WHERE id = ?2').bind(now, row.id),
    c.env.DB.prepare('UPDATE users SET email_verified = 1, updated_at = ?1 WHERE id = ?2')
      .bind(now, row.user_id),
  ])

  return c.json({ ok: true })
})
