import type { Env } from '../env'

/**
 * A fixed-window counter in KV, used on credential endpoints only. It is
 * approximate — two concurrent requests can both read the same count — which is
 * fine for slowing a password guesser and is not fine for anything that must be
 * exact. Nothing exact depends on it.
 */
export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number }

export async function rateLimit(
  env: Env,
  key: string,
  { limit, windowSeconds }: { limit: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const window = Math.floor(Date.now() / (windowSeconds * 1000))
  const kvKey = `rl:${key}:${window}`

  let count: number
  try {
    count = Number(await env.SETTINGS.get(kvKey)) || 0
  } catch {
    // KV unavailable: fail open rather than locking everyone out of sign-in.
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 }
  }

  if (count >= limit) {
    const elapsed = Math.floor(Date.now() / 1000) % windowSeconds
    return { allowed: false, remaining: 0, retryAfterSeconds: windowSeconds - elapsed }
  }

  await env.SETTINGS.put(kvKey, String(count + 1), { expirationTtl: Math.max(60, windowSeconds) })
  return { allowed: true, remaining: limit - count - 1, retryAfterSeconds: 0 }
}
