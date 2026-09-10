import { Hono } from 'hono'
import type { Env } from '../env'
import { DEFAULT_CITY, inNepal, resolveCity } from '../lib/cities'
import type { Here } from './types'

/**
 * GET /api/catalog/here — where the request appears to be coming from (#38).
 *
 * **This is the fix the issue asks for, and then some.** WaahTickets called
 * `http://ip-api.com/json` from the page. Over HTTPS a browser blocks that
 * outright as mixed content, so the whole IP fallback was dead on any real
 * deployment — the "staged resolution" only ever had two stages. Moving it to
 * `https://ip-api.com` would have fixed the mixed content and kept everything
 * else wrong with it: a third party on the critical path of the first paint,
 * a 45-request-per-minute limit shared across every visitor behind one egress
 * IP, and every visitor's address handed to a company that is not us.
 *
 * Cloudflare already resolved this before the request arrived. `request.cf`
 * carries the city, the region and a coordinate for the client's IP, at no
 * latency cost and no quota, and this endpoint is same-origin — so there is
 * no mixed content to have, no CORS preflight, and no third party.
 *
 * It is deliberately not a precise location and does not pretend to be. It is
 * "which of twenty cities should the headline name and the map open on",
 * which is a question a geo-IP city is good enough to answer.
 */
export const hereRoutes = new Hono<{ Bindings: Env }>()

/**
 * A minute at the edge, and nothing in a shared cache.
 *
 * The response varies by client IP and there is no header to declare that
 * with, so a shared cache would serve one visitor's city to the next. `private`
 * keeps it in the browser that asked, which is where a per-visitor answer
 * belongs; a minute is long enough that a reload does not re-ask and short
 * enough that a phone changing networks is not stuck in the wrong city.
 */
const CACHE_CONTROL = 'private, max-age=60'

hereRoutes.get('/here', (c) => {
  // `cf` is absent under `vitest-pool-workers` and under `wrangler dev` without
  // a network, which is not an error — it is the same "we do not know" the
  // default exists for.
  const cf = (c.req.raw as { cf?: IncomingRequestCfProperties }).cf

  const lat = numberOf(cf?.latitude)
  const lng = numberOf(cf?.longitude)
  const named = typeof cf?.city === 'string' ? cf.city : null
  // A district or region name is a usable alias where the city is missing,
  // which for smaller Nepali towns it often is.
  const region = typeof cf?.region === 'string' ? cf.region : null

  const known = named !== null || (lat !== null && lng !== null)
  const city = resolveCity(named ?? region, lat, lng)

  // The city's own centroid, not the IP's coordinate. A geo-IP point is
  // accurate to somewhere between a suburb and a province, and opening the map
  // on it would put the viewer in a field outside town while telling them they
  // are in Pokhara. The centroid at least agrees with the headline.
  const body: Here = {
    city: city.name,
    city_ne: city.name_ne,
    lat: city.lat,
    lng: city.lng,
    source: known && city !== DEFAULT_CITY ? 'ip'
      : known && lat !== null && lng !== null && inNepal(lat, lng) ? 'ip'
      : 'default',
    in_nepal: lat !== null && lng !== null ? inNepal(lat, lng) : city !== DEFAULT_CITY || named !== null,
  }

  return Response.json(body, { headers: { 'cache-control': CACHE_CONTROL } })
})

/** `cf.latitude` arrives as a string, and sometimes not at all. */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
