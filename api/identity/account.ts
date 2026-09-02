import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest } from '../lib/http'
import { auditStatement } from '../lib/audit'
import { hashPassword, randomToken, sha256Hex, verifyPassword } from './password'
import { isRole, type Role } from './roles'
import { rateLimit } from './rateLimit'
import { requireAuth, requirePermission, type AuthVariables } from './middleware'
import { clearedSessionCookie, revokeAllSessions } from './sessions'

/**
 * Password lifecycle (#27) and role administration (#28) — the parts of an
 * account that change after it exists.
 */
export const accountRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const MIN_PASSWORD_LENGTH = 10
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000 // an hour; a reset link is not a session

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object') throw new Error('not an object')
    return body as Record<string, unknown>
  } catch {
    throw badRequest('invalid_body', 'Send a JSON object')
  }
}

function requireNewPassword(value: unknown): string {
  const password = String(value ?? '')
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest('weak_password', `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (password.length > 200) throw badRequest('invalid_password', 'That password is too long')
  return password
}

// ─── POST /api/auth/password/forgot ──────────────────────────────────────────
accountRoutes.post('/password/forgot', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  const throttled = await rateLimit(c.env, `forgot:${ip}`, { limit: 10, windowSeconds: 900 })
  if (!throttled.allowed) {
    throw new ApiError(429, 'rate_limited', `Too many attempts. Try again in ${throttled.retryAfterSeconds}s`)
  }

  const body = await readJson(c.req.raw)
  const email = String(body.email ?? '').trim().toLowerCase()

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?1 AND is_active = 1')
    .bind(email).first<{ id: string }>()

  let token: string | null = null
  if (user) {
    token = randomToken()
    const now = new Date().toISOString()
    await c.env.DB.batch([
      // Any earlier reset is void the moment a new one is asked for.
      c.env.DB.prepare(
        `UPDATE user_tokens SET used_at = ?1
          WHERE user_id = ?2 AND kind = 'password_reset' AND used_at IS NULL`,
      ).bind(now, user.id),
      c.env.DB.prepare(
        `INSERT INTO user_tokens (id, user_id, kind, token_hash, expires_at, created_at)
         VALUES (?1, ?2, 'password_reset', ?3, ?4, ?5)`,
      ).bind(crypto.randomUUID(), user.id, await sha256Hex(token),
             new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(), now),
    ])
  }

  // Always the same answer. Telling the caller whether an address has an
  // account turns this endpoint into an account enumerator.
  return c.json({
    ok: true,
    ...(c.env.ENVIRONMENT === 'production' || !token ? {} : { password_reset_token: token }),
  })
})

// ─── POST /api/auth/password/reset ───────────────────────────────────────────
accountRoutes.post('/password/reset', async (c) => {
  const body = await readJson(c.req.raw)
  const token = String(body.token ?? '')
  const password = requireNewPassword(body.password)
  if (!token) throw badRequest('invalid_token', 'Send the token from the reset link')

  const now = new Date().toISOString()
  const row = await c.env.DB.prepare(
    `SELECT id, user_id FROM user_tokens
      WHERE token_hash = ?1 AND kind = 'password_reset' AND used_at IS NULL AND expires_at > ?2`,
  ).bind(await sha256Hex(token), now).first<{ id: string; user_id: string }>()

  if (!row) throw badRequest('invalid_token', 'That link has expired or was already used')

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE user_tokens SET used_at = ?1 WHERE id = ?2').bind(now, row.id),
    c.env.DB.prepare('UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(await hashPassword(password), now, row.user_id),
    auditStatement(c.env, {
      entityType: 'user', entityId: row.user_id, action: 'password_reset',
      actorId: row.user_id, actorRole: null,
    }),
  ])

  // Whoever asked for the reset may be locking someone else out on purpose.
  await revokeAllSessions(c.env, row.user_id)
  c.header('set-cookie', clearedSessionCookie(c.env))

  return c.json({ ok: true })
})

// ─── POST /api/auth/password/change ──────────────────────────────────────────
accountRoutes.post('/password/change', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await readJson(c.req.raw)
  const current = String(body.current_password ?? '')
  const next = requireNewPassword(body.new_password)

  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1')
    .bind(user.id).first<{ password_hash: string | null }>()

  // A Google-only account has no password to confirm; it must use the reset
  // flow, which proves control of the mailbox instead.
  if (!row?.password_hash) {
    throw badRequest('no_password_set', 'This account signs in with Google — use a password reset')
  }
  if (!(await verifyPassword(current, row.password_hash))) {
    throw new ApiError(403, 'invalid_credentials', 'Your current password is wrong')
  }

  const now = new Date().toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(await hashPassword(next), now, user.id),
    auditStatement(c.env, {
      entityType: 'user', entityId: user.id, action: 'password_changed',
      actorId: user.id, actorRole: user.role,
    }),
  ])

  // Changing a password is how someone responds to a session being stolen, so
  // every other session goes with it — this one included.
  await revokeAllSessions(c.env, user.id)
  c.header('set-cookie', clearedSessionCookie(c.env))

  return c.json({ ok: true, sessions_revoked: true })
})

// ─── PATCH /api/auth/users/:id/role ──────────────────────────────────────────
accountRoutes.patch('/users/:id/role', requirePermission('user:manage'), async (c) => {
  const actor = c.get('user')
  const subjectId = c.req.param('id')
  const body = await readJson(c.req.raw)
  const role = body.role

  if (!isRole(role)) throw badRequest('invalid_role', 'role must be visitor, organizer, editor or admin')

  const subject = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?1')
    .bind(subjectId).first<{ id: string; role: Role }>()
  if (!subject) throw new ApiError(404, 'not_found', 'No such user')

  if (subject.id === actor.id && role !== actor.role) {
    throw badRequest('cannot_change_own_role', 'Ask another admin to change your own role')
  }

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET role = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(role, new Date().toISOString(), subject.id),
    auditStatement(c.env, {
      entityType: 'user', entityId: subject.id, action: 'role_changed',
      actorId: actor.id, actorRole: actor.role,
      details: { from: subject.role, to: role },
    }),
  ])

  // No session invalidation needed: the role is read from `users` on every
  // request, so the change is in force on the subject's very next call.
  return c.json({ id: subject.id, role, previous_role: subject.role })
})
