import type { Env } from '../env'
import type { Role } from './roles'
import { randomToken, sha256Hex } from './password'

export const SESSION_COOKIE = 'ns_session'
const SESSION_TTL_DAYS = 30
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000

export type AuthUser = {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  role: Role
  email_verified: boolean
  session_id: string
}

export async function createSession(
  env: Env,
  userId: string,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken()
  const id = await sha256Hex(token)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000).toISOString()

  await env.DB.prepare(
    `INSERT INTO user_sessions (id, user_id, expires_at, last_seen_at, user_agent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?4)`,
  ).bind(id, userId, expiresAt, now.toISOString(), userAgent?.slice(0, 255) ?? null).run()

  return { token, expiresAt }
}

/**
 * One query: the session and the user it belongs to. Authentication is on the
 * write path, not the public read path, but it is still a middleware — and a
 * middleware's cost multiplies across every route behind it.
 */
export async function resolveSession(
  env: Env,
  token: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<AuthUser | null> {
  const id = await sha256Hex(token)
  const now = new Date().toISOString()

  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.last_seen_at,
            u.id, u.email, u.name, u.avatar_url, u.role, u.email_verified
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2 AND u.is_active = 1`,
  ).bind(id, now).first<Record<string, unknown>>()

  if (!row) return null

  // Touch last_seen at most hourly, and never on the request's critical path.
  const lastSeen = Date.parse(String(row.last_seen_at))
  if (waitUntil && Date.now() - lastSeen > LAST_SEEN_REFRESH_MS) {
    waitUntil(
      env.DB.prepare('UPDATE user_sessions SET last_seen_at = ?1 WHERE id = ?2')
        .bind(now, id).run(),
    )
  }

  return {
    id: row.id as string,
    email: row.email as string,
    name: (row.name as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    role: row.role as Role,
    email_verified: row.email_verified === 1,
    session_id: row.session_id as string,
  }
}

export async function revokeSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare('UPDATE user_sessions SET revoked_at = ?1 WHERE id = ?2')
    .bind(new Date().toISOString(), sessionId).run()
}

/** Sign out everywhere — the one account action worth having from day one. */
export async function revokeAllSessions(env: Env, userId: string): Promise<number> {
  const result = await env.DB.prepare(
    'UPDATE user_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL',
  ).bind(new Date().toISOString(), userId).run()
  return result.meta.changes ?? 0
}

export function sessionCookie(env: Env, token: string, expiresAt: string): string {
  return cookie(env, `${SESSION_COOKIE}=${token}`, `Expires=${new Date(expiresAt).toUTCString()}`)
}

export function clearedSessionCookie(env: Env): string {
  return cookie(env, `${SESSION_COOKIE}=`, 'Max-Age=0')
}

function cookie(env: Env, pair: string, lifetime: string): string {
  // Secure is dropped locally only, where there is no https to set it against.
  const secure = env.ENVIRONMENT === 'local' ? '' : ' Secure;'
  return `${pair}; Path=/; HttpOnly;${secure} SameSite=Lax; ${lifetime}`
}

export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return rest.join('=') || undefined
  }
  return undefined
}
