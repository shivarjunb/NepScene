import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest } from '../lib/http'
import { auditStatement } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { hashPassword, randomToken, sha256Hex, verifyPassword } from './password'
import { isRole, type Role } from './roles'
import { rateLimit } from './rateLimit'
import { requireAuth, requirePermission, type AuthVariables } from './middleware'
import { clearedSessionCookie, revokeAllSessions } from './sessions'

/**
 * Everything an account does after it exists: the password lifecycle (#27),
 * role administration (#28), and account management (#29) — changing an email
 * address, exporting what is held, and leaving.
 */
export const accountRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const MIN_PASSWORD_LENGTH = 10
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000 // an hour; a reset link is not a session
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000
const EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/

/**
 * Publication states that outlive the account that wrote them (#29).
 *
 * The rule is: what was published stays published, what was never published
 * goes. A published listing is the community's — someone has already linked to
 * it, and deleting an organizer must not quietly remove the events people are
 * planning to attend. A draft is the person's own unfinished writing, and
 * keeping it after they leave is a privacy problem rather than a preservation
 * one.
 */
const SURVIVING_STATUSES = ['published', 'archived']

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

// ─── POST /api/auth/email/change ─────────────────────────────────────────────
/**
 * Asks for a new address. Does not change it.
 *
 * The token goes to the *new* mailbox, so the change proves control of the
 * address being claimed rather than of the session making the claim — which is
 * the difference between an email change and an account takeover by whoever
 * reaches an unlocked laptop. Until the token comes back, `email` is untouched:
 * sign-in, password reset and every notification still go where they went.
 */
accountRoutes.post('/email/change', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await readJson(c.req.raw)
  const email = String(body.email ?? '').trim().toLowerCase()

  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw badRequest('invalid_email', 'That does not look like an email address')
  }
  if (email === user.email) {
    throw badRequest('same_email', 'That is already your address')
  }

  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1')
    .bind(user.id).first<{ password_hash: string | null }>()
  // A Google-only account has no password to confirm with; Google is the proof
  // of control, and the address it supplies is not ours to reassign.
  if (!row?.password_hash) {
    throw badRequest('no_password_set', 'This account signs in with Google — its address comes from there')
  }
  if (!(await verifyPassword(String(body.current_password ?? ''), row.password_hash))) {
    throw new ApiError(403, 'invalid_credentials', 'Your current password is wrong')
  }

  const taken = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?1')
    .bind(email).first<{ id: string }>()
  // Answering honestly here tells a signed-in person whether an address they
  // typed has an account. They already had to prove who they are to ask.
  if (taken) throw badRequest('email_taken', 'That address is already in use')

  const token = randomToken()
  const now = new Date().toISOString()
  await c.env.DB.batch([
    // Asking again voids the previous request, so two pending addresses cannot
    // race to be applied.
    c.env.DB.prepare(
      `UPDATE user_tokens SET used_at = ?1
        WHERE user_id = ?2 AND kind = 'email_verify' AND used_at IS NULL`,
    ).bind(now, user.id),
    c.env.DB.prepare('UPDATE users SET pending_email = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(email, now, user.id),
    c.env.DB.prepare(
      `INSERT INTO user_tokens (id, user_id, kind, token_hash, expires_at, created_at)
       VALUES (?1, ?2, 'email_verify', ?3, ?4, ?5)`,
    ).bind(crypto.randomUUID(), user.id, await sha256Hex(token),
           new Date(Date.now() + EMAIL_CHANGE_TTL_MS).toISOString(), now),
    auditStatement(c.env, {
      entityType: 'user', entityId: user.id, action: 'email_change_requested',
      actorId: user.id, actorRole: user.role,
    }),
  ])

  return c.json({
    ok: true,
    pending_email: email,
    ...(c.env.ENVIRONMENT === 'production' ? {} : { email_verify_token: token }),
  })
})

// ─── GET /api/auth/me/export ─────────────────────────────────────────────────
/**
 * Everything held about the person, in the format it is held in.
 *
 * Not a summary and not a rendering: the point of an export is that someone can
 * check it against what they believe is stored, so the columns come back under
 * the names they have in the database. The password digest is the one omission
 * — it is a credential, not a fact about the person, and handing it over turns
 * an export into an offline cracking target.
 */
accountRoutes.get('/me/export', requireAuth, async (c) => {
  const user = c.get('user')
  const id = user.id

  // One batch: an export is six reads that have nothing to say to each other,
  // and six sequential round trips is the difference between a click and a wait.
  const results = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT id, email, pending_email, email_verified, name, avatar_url, role,
              google_sub IS NOT NULL AS has_google, password_hash IS NOT NULL AS has_password,
              is_active, last_login_at, created_at, updated_at
         FROM users WHERE id = ?1`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT expires_at, last_seen_at, user_agent, revoked_at, created_at
         FROM user_sessions WHERE user_id = ?1 ORDER BY created_at`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT o.id, o.slug, o.name, ou.org_role, ou.created_at
         FROM organization_users ou JOIN organizations o ON o.id = ou.organization_id
        WHERE ou.user_id = ?1`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT id, slug, title, listing_type, source, status, starts_at, published_at, created_at
         FROM listings WHERE created_by = ?1 ORDER BY created_at`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT id, listing_id, mime_type, width, height, bytes, alt_text, created_at
         FROM listing_media WHERE created_by = ?1 ORDER BY created_at`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT entity_type, entity_id, action, actor_role, details, created_at
         FROM audit_log WHERE actor_id = ?1 ORDER BY created_at`,
    ).bind(id),
  ])
  const [account, sessions, organizations, listings, media, audit] =
    results.map((result) => result.results)

  return c.json(
    {
      exported_at: new Date().toISOString(),
      account: account?.[0] ?? null,
      sessions: sessions ?? [],
      organizations: organizations ?? [],
      listings: listings ?? [],
      media: media ?? [],
      audit_log: audit ?? [],
    },
    200,
    // Named so a browser saves it rather than rendering it, because "export"
    // that has to be copied out of a tab is not an export.
    { 'content-disposition': `attachment; filename="nepscene-account-${id}.json"` },
  )
})

// ─── DELETE /api/auth/me ─────────────────────────────────────────────────────
/**
 * Leaving (#29). Three things happen, in this order, and the order matters.
 *
 * 1. Unpublished work goes. Drafts, submissions awaiting review and rejected
 *    listings created by this person are deleted with their images. They were
 *    never the catalogue's.
 * 2. Published and archived listings survive, with `created_by` cleared. They
 *    belong to the catalogue — people have linked to them and are planning to
 *    attend them. Where the listing has an organization, that organization's
 *    other members keep editing it exactly as before; where it does not, it
 *    falls to editors, which is what `listing:edit_any` is for. Nothing new is
 *    invented to hold it.
 * 3. The person goes. The row is deleted rather than flagged inactive —
 *    sessions, tokens and memberships cascade — and their audit entries keep
 *    the action and the role while losing the actor. What the catalogue did is
 *    its own history; who did it stops being personal data the moment the id
 *    is gone.
 *
 * Confirmation is required because a session is not consent: a stolen cookie
 * should not be able to erase an account.
 */
accountRoutes.delete('/me', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await readJson(c.req.raw)

  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1')
    .bind(user.id).first<{ password_hash: string | null }>()

  if (row?.password_hash) {
    if (!(await verifyPassword(String(body.current_password ?? ''), row.password_hash))) {
      throw new ApiError(403, 'invalid_credentials', 'Your current password is wrong')
    }
  } else if (String(body.confirm_email ?? '').trim().toLowerCase() !== user.email) {
    // A Google-only account has no password to confirm with, so typing the
    // address is the deliberate act instead.
    throw badRequest('confirmation_required', 'Send confirm_email with your own address')
  }

  // Inlined rather than bound: these are a constant in this file, not input,
  // and giving each statement its own placeholder numbering for them is how the
  // status list ends up colliding with `now`.
  const surviving = SURVIVING_STATUSES.map((status) => `'${status}'`).join(', ')

  // R2 keys for the drafts that are about to go, read while the rows that name
  // them still exist.
  const doomedMedia = await c.env.DB.prepare(
    `SELECT m.r2_key FROM listing_media m
       JOIN listings l ON l.id = m.listing_id
      WHERE l.created_by = ?1 AND l.status NOT IN (${surviving})
     UNION ALL
     SELECT d.r2_key FROM media_derivatives d
       JOIN listing_media m ON m.id = d.media_id
       JOIN listings l ON l.id = m.listing_id
      WHERE l.created_by = ?1 AND l.status NOT IN (${surviving})`,
  ).bind(user.id).all<{ r2_key: string }>()

  const transferred = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM listings WHERE created_by = ?1 AND status IN (${surviving})`,
  ).bind(user.id).first<{ n: number }>()

  const now = new Date().toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM listings WHERE created_by = ?1 AND status NOT IN (${surviving})`,
    ).bind(user.id),
    c.env.DB.prepare(
      `UPDATE listings SET created_by = NULL, updated_at = ?2
        WHERE created_by = ?1 AND status IN (${surviving})`,
    ).bind(user.id, now),
    c.env.DB.prepare('UPDATE listing_media SET created_by = NULL WHERE created_by = ?1').bind(user.id),
    c.env.DB.prepare('UPDATE venues SET created_by = NULL WHERE created_by = ?1').bind(user.id),
    c.env.DB.prepare('UPDATE organizations SET created_by = NULL WHERE created_by = ?1').bind(user.id),
    // The record of what happened stays; the actor becomes anonymous. This has
    // to precede the delete — audit_log.actor_id references users(id).
    c.env.DB.prepare(
      `UPDATE audit_log SET actor_id = NULL, details = json_patch(COALESCE(details, '{}'), ?2)
        WHERE actor_id = ?1`,
    ).bind(user.id, JSON.stringify({ actor: 'deleted account' })),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(user.id),
  ])

  const keys = doomedMedia.results.map((media) => media.r2_key)
  if (keys.length > 0) c.executionCtx.waitUntil(c.env.MEDIA.delete(keys))
  // Published listings changed hands, so what the public read path returns for
  // them changed with it.
  c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

  c.header('set-cookie', clearedSessionCookie(c.env))
  return c.json({
    ok: true,
    listings_transferred: transferred?.n ?? 0,
    media_objects_deleted: keys.length,
  })
})
