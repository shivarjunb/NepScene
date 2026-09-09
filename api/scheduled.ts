import type { Env } from './env'
import { archiveFinishedListings } from './author/archive'

/**
 * The Worker's cron half (#33).
 *
 * There is exactly one scheduled job and it is deliberate: a `scheduled`
 * handler is a place where work happens with nobody watching, so anything that
 * can be done on a request path should be. Auto-archive cannot — the read path
 * is edge-cached and must not carry a write, and there is no request that
 * naturally coincides with "this event has now finished".
 *
 * Failures are thrown rather than swallowed. A cron that fails silently is a
 * catalogue that slowly fills with finished events and no signal that anything
 * is wrong; Workers' observability records the exception (wrangler.jsonc).
 */
export async function scheduled(
  event: ScheduledController, env: Env, ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil((async () => {
    const result = await archiveFinishedListings(env)
    if (result.archived.length > 0) {
      console.log(`auto-archive: ${result.archived.length} listings (cron ${event.cron})`)
    }
  })())
}
