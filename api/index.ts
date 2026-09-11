import { Hono } from 'hono'
import type { Env } from './env'
import { authorListingRoutes } from './author/listings'
import { authorMediaRoutes } from './author/media'
import { authorLookupRoutes } from './author/lookups'
import { authorVenueRoutes } from './author/venues'
import { authorWriteRoutes } from './author/write'
import { dashboardRoutes } from './author/dashboard'
import { moderationRoutes } from './author/moderation'
import { catalogRoutes } from './catalog/routes'
import { googleRoutes } from './identity/google'
import { accountRoutes } from './identity/account'
import { identityRoutes } from './identity/routes'
import { withUser } from './identity/middleware'
import type { AuthVariables } from './identity/middleware'
import { healthRoutes } from './health/routes'
import { mediaRoutes } from './media/routes'
import { ApiError, errorResponse, requestId } from './lib/http'
import { logEvent, requestFailed, setRequestId } from './lib/observability'
import { MovedPermanently } from './render/data'
import { handleSeoRoute, matchRenderRoute } from './render/routes'
import { scheduled } from './scheduled'

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/**
 * The only wildcard middleware on the API, and it does no I/O. A middleware's
 * cost multiplies across every route behind it: WaahTickets ran eight DDL
 * statements in one, which is where ~1.6s of its ~2s response time went
 * (docs/ARCHITECTURE.md, rule 4).
 */
app.use('/api/*', async (c, next) => {
  const id = requestId(c)
  // Published so anything that logs during this request carries the same id —
  // which is what makes an error findable from the response the reporter saw
  // (#50). Cleared afterwards so a log line from outside a request cannot
  // inherit a stale one and point at the wrong trace.
  setRequestId(id)
  try {
    await next()
  } finally {
    // Set on the finished response, not the context: catalog handlers return a
    // Response built by the cache wrapper, which replaces anything staged here.
    c.res?.headers.set('x-request-id', id)
    setRequestId(null)
  }
})

// Catalog is public and read-only; browsers may call it from anywhere.
app.use('/api/catalog/*', async (c, next) => {
  await next()
  c.res.headers.set('access-control-allow-origin', '*')
})

// Session lookup runs only where a session is meaningful. The catalog is
// anonymous so that it stays cacheable and free of a per-request D1 lookup.
app.use('/api/auth/*', withUser)
app.use('/api/author/*', withUser)

app.route('/api', healthRoutes)
app.route('/api/catalog', catalogRoutes)
app.route('/api/media', mediaRoutes)
app.route('/api/auth/google', googleRoutes)
app.route('/api/auth', accountRoutes)
app.route('/api/auth', identityRoutes)
app.route('/api/author', authorLookupRoutes)
app.route('/api/author', authorVenueRoutes)
app.route('/api/author', authorWriteRoutes)
app.route('/api/author', authorListingRoutes)
app.route('/api/author', authorMediaRoutes)
app.route('/api/author', moderationRoutes)
app.route('/api/author', dashboardRoutes)

/**
 * Counted like any other failure (#50).
 *
 * Hono routes a miss here rather than through `onError`, so a 404 was the one
 * error class that reached a client without being recorded — and it is the one
 * most likely to mean something: a spike of them is a broken link somewhere
 * public, or a client built against an endpoint that has moved.
 */
app.notFound((c) => {
  requestFailed(404, 'not_found', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  })
  return errorResponse(new ApiError(404, 'not_found', 'No such endpoint'), requestId(c))
})
/**
 * Every error that reaches a client is counted before it is rendered (#50).
 *
 * Not to preserve the signal — a 500 is already visible to whoever got it —
 * but so the *rate* is something an alert can be attached to. A single 500 is
 * a bad afternoon for one person; fifty in a minute is an incident, and
 * nothing distinguishes them from inside a response body.
 */
app.onError((err, c) => {
  const known = err instanceof ApiError
  requestFailed(known ? err.status : 500, known ? err.code : 'internal_error', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    // The message only for errors we raised deliberately. An unexpected one
    // can carry anything, including a fragment of a row.
    message: known ? err.message : undefined,
  })
  return errorResponse(err, requestId(c))
})

/**
 * The public site, server-rendered (#45).
 *
 * This sits outside the Hono app rather than inside it because it is not an
 * API: it answers with a document, it falls through to the static asset for
 * anything it does not own, and it must not inherit the API's error shape —
 * a reader who asks for a listing that has been taken down should get a page,
 * not `{"error":{...}}`.
 *
 * **A rendering failure serves the SPA rather than an error.** The static
 * shell still boots, fetches and paints; what is lost is the crawler's copy
 * and one round trip. Turning a transient D1 problem into a blank 500 on every
 * public page is the worse trade, and it is the trade a naïve `throw` makes.
 */
async function handlePage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)

  const seo = await handleSeoRoute(env, url)
  if (seo) return seo

  const route = matchRenderRoute(url.pathname)
  if (!route) return env.ASSETS.fetch(request)

  try {
    const data = await route.load(env)
    // Imported here rather than at the top of the file: the renderer pulls in
    // React and the whole component tree, and a request for a static asset
    // should not pay to parse it.
    const { renderPage, languageOf } = await import('./render/page')
    return await renderPage(env, request, data, languageOf(url))
  } catch (error) {
    if (error instanceof MovedPermanently) {
      return Response.redirect(new URL(error.location, url).toString(), 301)
    }
    if (error instanceof ApiError && error.status === 404) {
      // The SPA renders its own not-found page, and the status is what tells a
      // crawler not to keep the URL.
      const shell = await env.ASSETS.fetch(new Request(new URL('/index.html', url)))
      return new Response(shell.body, {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    // Structured, and carrying the correlation id, so this is findable from
    // the `x-request-id` a reader can be asked for (#50). It is an `error`
    // rather than a `swallowed`: the page still renders, but a crawler got the
    // empty shell, which is a real regression rather than a graceful degrade.
    logEvent('error', 'render_failed', {
      path: url.pathname,
      cause: error instanceof Error ? error.message : String(error),
    })
    ctx.passThroughOnException?.()
    return env.ASSETS.fetch(request)
  }
}

/**
 * Two entry points, not one. `fetch` is the Hono app plus the rendered public
 * site; `scheduled` is the nightly auto-archive sweep (api/scheduled.ts).
 * Exporting the app directly would leave the cron trigger in wrangler.jsonc
 * firing into a Worker with no handler for it — which fails silently, since
 * nothing is waiting on a cron.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    // `/api/*` is the API's, and everything else is either a page this Worker
    // renders or an asset it hands straight back. The split is here rather
    // than in Hono's router so that a page never picks up API middleware.
    if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx)

    // Pages do not go through the Hono middleware that publishes this, so they
    // set it themselves — otherwise a swallowed error during a render would be
    // logged with no correlation id at all, which is the half of #50 that makes
    // the other half usable.
    setRequestId(request.headers.get('cf-ray') ?? crypto.randomUUID())
    try {
      return await handlePage(request, env, ctx)
    } finally {
      setRequestId(null)
    }
  },
  scheduled,
}
