import { Hono } from 'hono'
import type { Env } from './env'
import { authorListingRoutes } from './author/listings'
import { authorMediaRoutes } from './author/media'
import { catalogRoutes } from './catalog/routes'
import { googleRoutes } from './identity/google'
import { accountRoutes } from './identity/account'
import { identityRoutes } from './identity/routes'
import { withUser } from './identity/middleware'
import type { AuthVariables } from './identity/middleware'
import { healthRoutes } from './health/routes'
import { mediaRoutes } from './media/routes'
import { ApiError, errorResponse, requestId } from './lib/http'

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
app.route('/api/author', authorListingRoutes)
app.route('/api/author', authorMediaRoutes)

app.notFound((c) =>
  errorResponse(new ApiError(404, 'not_found', 'No such endpoint'), requestId(c)),
)
app.onError((err, c) => errorResponse(err, requestId(c)))

export default app
