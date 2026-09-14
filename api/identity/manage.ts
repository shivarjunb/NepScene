import type { Env } from '../env'
import { ApiError, badRequest } from '../lib/http'
import { auditStatement } from '../lib/audit'
import type { Role } from './roles'
import { revokeAllSessions, type AuthUser } from './sessions'

/**
 * The two things an administrator does to another account (#28): change what
 * it may do, and switch it off. Both are here rather than in a route handler
 * because two routes need them — the original `PATCH /api/auth/users/:id/role`
 * and the admin console's `PATCH /api/admin/users/:id` — and a rule that
 * exists twice is a rule that will be relaxed in one place and not the other.
 *
 * Both refuse to act on the caller. An admin who demotes or deactivates
 * themselves has locked the door from the outside; another admin can always
 * undo it, and a mistake that needs a second person is a mistake that gets a
 * second look.
 */
type Subject = { id: string; role: Role; is_active: number }

async function loadSubject(env: Env, id: string): Promise<Subject> {
  const subject = await env.DB.prepare('SELECT id, role, is_active FROM users WHERE id = ?1')
    .bind(id).first<Subject>()
  if (!subject) throw new ApiError(404, 'not_found', 'No such user')
  return subject
}

export async function changeRole(
  env: Env, actor: AuthUser, subjectId: string, role: Role,
): Promise<{ id: string; role: Role; previous_role: Role }> {
  const subject = await loadSubject(env, subjectId)

  if (subject.id === actor.id && role !== actor.role) {
    throw badRequest('cannot_change_own_role', 'Ask another admin to change your own role')
  }

  if (subject.role !== role) {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET role = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(role, new Date().toISOString(), subject.id),
      auditStatement(env, {
        entityType: 'user', entityId: subject.id, action: 'role_changed',
        actorId: actor.id, actorRole: actor.role,
        details: { from: subject.role, to: role },
      }),
    ])
  }

  // No session invalidation needed: the role is read from `users` on every
  // request, so the change is in force on the subject's very next call.
  return { id: subject.id, role, previous_role: subject.role }
}

/**
 * Deactivating also revokes every session: `resolveSession` joins on
 * `is_active = 1`, so the sessions would be dead anyway, but a revoked row
 * says *when* and a dead-by-join row does not. Reactivating does not bring
 * them back — the person signs in again, which is the point.
 */
export async function setActive(
  env: Env, actor: AuthUser, subjectId: string, active: boolean,
): Promise<{ id: string; is_active: boolean }> {
  const subject = await loadSubject(env, subjectId)

  if (subject.id === actor.id && !active) {
    throw badRequest('cannot_deactivate_self', 'Ask another admin to deactivate your account')
  }

  if ((subject.is_active === 1) !== active) {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET is_active = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(active ? 1 : 0, new Date().toISOString(), subject.id),
      auditStatement(env, {
        entityType: 'user', entityId: subject.id,
        action: active ? 'reactivated' : 'deactivated',
        actorId: actor.id, actorRole: actor.role,
      }),
    ])
    if (!active) await revokeAllSessions(env, subject.id)
  }

  return { id: subject.id, is_active: active }
}
