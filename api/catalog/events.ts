import { Hono } from 'hono'
import type { Env } from '../env'
import { badRequest } from '../lib/http'

/**
 * The counting beacon (#34): one endpoint, two verbs, no identity.
 *
 * **Why counting is a write on the public side at all.** The alternative is
 * reading a log somewhere else — Workers Analytics Engine, or the platform's
 * own request metrics — and neither can answer "how many people looked at
 * *this listing*" in a query an organizer's dashboard can join against. The
 * cost is one D1 upsert per view, off the response path.
 *
 * **It is a POST from JavaScript, and that is the bot filter.** A crawler
 * fetching the page never runs it, which removes the largest source of noise
 * for free and without a user-agent list that would need maintaining. What
 * gets through is a real browser that loaded the page.
 *
 * **Nothing here identifies anybody.** No cookie is read, no IP is stored, and
 * the row is a counter with no dimension but the day — so there is nothing to
 * disclose in the privacy page beyond "we count views" and nothing to delete
 * when an account is (docs/SCOPE.md, and the account deletion in #29).
 */
export const eventRoutes = new Hono<{ Bindings: Env }>()

const KINDS = ['view', 'click'] as const
type Kind = (typeof KINDS)[number]

/** Nepal is UTC+5:45, and a Friday gig is looked up until 2am on Saturday. */
const KATHMANDU_OFFSET_MS = 5.75 * 60 * 60 * 1000

export const kathmanduDay = (at = new Date()): string =>
  new Date(at.getTime() + KATHMANDU_OFFSET_MS).toISOString().slice(0, 10)

eventRoutes.post('/listings/:slug/events', async (c) => {
  const body = await c.req.json().catch(() => null) as { kind?: unknown } | null
  const kind = typeof body?.kind === 'string' ? body.kind : ''
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw badRequest('invalid_kind', `A listing event is one of: ${KINDS.join(', ')}`)
  }

  const slug = c.req.param('slug')
  const day = kathmanduDay()
  const column = kind as Kind

  /**
   * The whole thing is one statement, and it resolves the slug inside the
   * INSERT rather than looking it up first. A separate SELECT would double the
   * cost of the most frequent write in the system to learn something the
   * INSERT can establish on its own — and if the slug is unknown, zero rows are
   * inserted, which is exactly the desired outcome.
   *
   * Only `published` listings are counted. A draft has no public page, so a
   * beacon naming one is either a stale tab or somebody poking at the endpoint;
   * either way it is not a view.
   */
  const statement = c.env.DB.prepare(
    `INSERT INTO listing_stats (listing_id, day, views, clicks)
     SELECT l.id, ?2, ?3, ?4 FROM listings l
      WHERE l.slug = ?1 AND l.status = 'published'
     ON CONFLICT (listing_id, day)
     DO UPDATE SET views = views + ?3, clicks = clicks + ?4`,
  ).bind(slug, day, column === 'view' ? 1 : 0, column === 'click' ? 1 : 0)

  // 202 and go. The visitor is reading a page; they must not wait on a
  // counter, and a failed count is not a failed page view.
  c.executionCtx.waitUntil(statement.run().catch(() => {}))

  return c.body(null, 202)
})
