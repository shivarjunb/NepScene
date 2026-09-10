import { Hono } from 'hono'
import type { Env } from '../env'
import { eventRoutes } from './events'
import { listingRoutes } from './listings'
import { placeRoutes } from './places'
import { referenceRoutes } from './reference'
import { searchRoutes } from './search'

/**
 * The catalog module's composition root. Handlers live next door, grouped by
 * what they serve; shared filter parsing and paging live in `shared.ts`.
 */
export const catalogRoutes = new Hono<{ Bindings: Env }>()

catalogRoutes.route('/', referenceRoutes)
catalogRoutes.route('/', searchRoutes)
catalogRoutes.route('/', eventRoutes)
catalogRoutes.route('/', placeRoutes)
// Last: `/listings/:slug` must not shadow the more specific routes above.
catalogRoutes.route('/', listingRoutes)
