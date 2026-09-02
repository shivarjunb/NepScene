import type { Env } from '../env'

/**
 * The audit trail (#20, #28). Every write that changes something a person could
 * be asked about later records who did it and when.
 *
 * `actor_role` is stored as it was at the time. Reading today's role off the
 * user row later would rewrite history the moment someone is promoted.
 */
export type AuditEntry = {
  entityType: 'listing' | 'venue' | 'organization' | 'user' | 'media'
  entityId: string
  action: string
  actorId: string | null
  actorRole: string | null
  details?: Record<string, unknown>
}

export function auditStatement(env: Env, entry: AuditEntry) {
  return env.DB.prepare(
    `INSERT INTO audit_log (id, entity_type, entity_id, action, actor_id, actor_role, details, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    crypto.randomUUID(), entry.entityType, entry.entityId, entry.action,
    entry.actorId, entry.actorRole,
    entry.details ? JSON.stringify(entry.details) : null,
    new Date().toISOString(),
  )
}

/**
 * Audit writes ride along with the change they describe wherever possible, so
 * a failure cannot leave one without the other. Use this only where the change
 * has already committed.
 */
export async function recordAudit(env: Env, entry: AuditEntry): Promise<void> {
  await auditStatement(env, entry).run()
}
