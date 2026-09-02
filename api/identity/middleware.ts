import type { MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { ApiError } from '../lib/http'
import { can, type Permission } from './roles'
import { readSessionCookie, resolveSession, type AuthUser } from './sessions'

export type AuthVariables = { user: AuthUser }

/**
 * Populates `user` when a valid session cookie is present. Never rejects.
 *
 * Mounted on the authoring and account routes only — deliberately NOT on the
 * catalog. A signed-in visitor browsing the catalogue would otherwise pay a D1
 * round trip per request, and a per-user response cannot be cached at the edge.
 * Discovery is anonymous by design.
 */
export const withUser: MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> =
  async (c, next) => {
    const token = readSessionCookie(c.req.header('cookie'))
    if (token) {
      const user = await resolveSession(c.env, token, (p) => c.executionCtx.waitUntil(p))
      if (user) c.set('user', user)
    }
    await next()
  }

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> =
  async (c, next) => {
    if (!c.get('user')) throw new ApiError(401, 'unauthenticated', 'Sign in to do that')
    await next()
  }

export function requirePermission(
  permission: Permission,
): MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> {
  return async (c, next) => {
    const user = c.get('user')
    if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to do that')
    // The handler asks what the user may do, never what they are.
    if (!can(user.role, permission)) {
      throw new ApiError(403, 'forbidden', 'Your account cannot do that')
    }
    await next()
  }
}
