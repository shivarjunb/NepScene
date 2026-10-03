import type { MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { ApiError } from '../lib/http'
import { notConfigured } from '../scrapes/runs'

/**
 * How a GitHub Actions job proves it is one: a shared bearer token, compared
 * against a Worker secret. Each caller gets its own secret, named by `secret`,
 * so a token handed to one job opens that job's routes and nothing else —
 * the scrape runner's token cannot start a production deploy, and the
 * staging deploy's cannot report a scrape.
 *
 * Missing secret → 503 rather than 401: the environment has not been set up,
 * which is not the caller's fault and should read differently in its log.
 */
export function runnerToken(secret: (env: Env) => string | undefined, what: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const expected = secret(c.env)
    if (!expected) throw notConfigured(what)
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token || !tokensMatch(token, expected)) {
      throw new ApiError(401, 'unauthenticated', 'That token does not open this')
    }
    await next()
  }
}

/** Constant-time, so a wrong token learns nothing from how long the answer took. */
function tokensMatch(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected)
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
