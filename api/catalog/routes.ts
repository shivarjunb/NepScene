import { Hono } from 'hono'
import type { Env } from '../env'
import { listingRoutes } from './listings'
import { placeRoutes } from './places'
import { referenceRoutes } from './reference'

/**
 * The catalog module's composition root. Handlers live next door, grouped by
 * what they serve; shared filter parsing and paging live in `shared.ts`.
 */
export const catalogRoutes = new Hono<{ Bindings: Env }>()

catalogRoutes.route('/', referenceRoutes)
catalogRoutes.route('/', placeRoutes)
// Last: `/listings/:slug` must not shadow the more specific routes above.
catalogRoutes.route('/', listingRoutes)
