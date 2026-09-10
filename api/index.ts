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
  await next()
  // Set on the finished response, not the context: catalog handlers return a
  // Response built by the cache wrapper, which replaces anything staged here.
  c.res.headers.set('x-request-id', id)
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

app.notFound((c) =>
  errorResponse(new ApiError(404, 'not_found', 'No such endpoint'), requestId(c)),
)
app.onError((err, c) => errorResponse(err, requestId(c)))

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
    console.error('render failed', url.pathname, error)
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
    return handlePage(request, env, ctx)
  },
  scheduled,
}
