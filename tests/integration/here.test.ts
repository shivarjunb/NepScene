import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Here } from '../../api/catalog/types'

/**
 * #38's integration criterion: "confirm the IP endpoint is HTTPS".
 *
 * It is stronger than that here, and the test says so: there is no IP endpoint
 * to make HTTPS, because there is no third party left to call. WaahTickets
 * fetched `http://ip-api.com/json` from the page, which a browser on an HTTPS
 * page blocks outright as mixed content — so its IP fallback never ran in
 * production at all. Cloudflare resolved the same thing before the request
 * arrived, so this is a same-origin read of `request.cf`.
 *
 * `cf` is absent under `vitest-pool-workers`, which is the *default* branch
 * and the one most likely to be wrong in a way nothing notices: the map still
 * has to open on a real city.
 */
const here = async (path = '/api/catalog/here') => {
  const response = await SELF.fetch(`https://nepscene.test${path}`)
  return { response, body: (await response.json()) as Here }
}

describe('where the visitor appears to be', () => {
  it('always answers with a city, a coordinate and how it got there', async () => {
    const { response, body } = await here()
    expect(response.status).toBe(200)
    expect(typeof body.city).toBe('string')
    expect(body.city.length).toBeGreaterThan(0)
    expect(Number.isFinite(body.lat)).toBe(true)
    expect(Number.isFinite(body.lng)).toBe(true)
    expect(['ip', 'default']).toContain(body.source)
  })

  it('falls back to Kathmandu when the edge told it nothing', async () => {
    // The default is a real answer, not an error. A map that refused to open
    // because geo-IP was unavailable would be broken for every visitor behind
    // a VPN.
    const { body } = await here()
    expect(body.city).toBe('Kathmandu')
    expect(body.source).toBe('default')
    expect(body.lat).toBeCloseTo(27.7172, 4)
    expect(body.lng).toBeCloseTo(85.324, 4)
  })

  it('names the city in both languages, so a Nepali headline is not half-English', async () => {
    const { body } = await here()
    expect(body.city).toBe('Kathmandu')
    expect(body.city_ne).toBe('काठमाडौं')
  })

  it('never puts a per-visitor answer in a shared cache', async () => {
    // The response varies by client IP and there is no header that says so, so
    // a shared cache would hand one visitor's city to the next.
    const { response } = await here()
    const cacheControl = response.headers.get('cache-control') ?? ''
    expect(cacheControl).toContain('private')
    expect(cacheControl).not.toContain('public')
  })

  it('needs no third party, and therefore no mixed content', async () => {
    // The endpoint is same-origin by construction — it is served by this
    // Worker. Nothing to assert about a scheme; the assertion is that the
    // route exists here at all, and this whole file is that assertion.
    const { response } = await here()
    expect(response.status).toBe(200)
  })

  it('is not shadowed by the listing route below it', async () => {
    // `/listings/:slug` is mounted last for exactly this reason, and `/here`
    // is a plausible slug.
    const { response, body } = await here()
    expect(response.status).toBe(200)
    expect(body).not.toHaveProperty('slug')
  })
})
