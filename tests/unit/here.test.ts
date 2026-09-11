import { describe, expect, it } from 'vitest'
import { resolveHere } from '../../api/catalog/here'

/**
 * What the edge told us, turned into an answer (#38).
 *
 * Tested here rather than through the endpoint because `request.cf` cannot be
 * produced inside `vitest-pool-workers` — it serves requests with no `cf` at
 * all, so an endpoint test can only ever exercise the default branch, which is
 * exactly the branch least likely to be wrong.
 *
 * The distinction the whole function exists to preserve: `resolveCity` returns
 * Kathmandu both when it recognised Kathmandu and when it recognised nothing,
 * so a visitor in Thamel and a visitor in Delhi get the same `city`. `source`
 * is what tells them apart, and it is the field a client uses to decide
 * whether to say "we think you are here" or just to open somewhere sensible.
 */

const cf = (over: Record<string, unknown>) =>
  over as Partial<IncomingRequestCfProperties>

describe('resolving where a request came from', () => {
  it('defaults to Kathmandu when the edge said nothing', () => {
    const here = resolveHere(undefined)
    expect(here).toMatchObject({
      city: 'Kathmandu', city_ne: 'काठमाडौं', source: 'default', in_nepal: false,
    })
    expect(here.lat).toBeCloseTo(27.7172, 4)
  })

  it('defaults when `cf` is present but carries nothing usable', () => {
    expect(resolveHere(cf({}))).toMatchObject({ city: 'Kathmandu', source: 'default' })
  })

  it('names the city the edge named', () => {
    expect(resolveHere(cf({ city: 'Pokhara' }))).toMatchObject({
      city: 'Pokhara', city_ne: 'पोखरा', source: 'ip', in_nepal: true,
    })
  })

  it('falls back to the region where the city is missing', () => {
    // Which for smaller Nepali towns it often is.
    expect(resolveHere(cf({ region: 'Kaski' })).city).toBe('Pokhara')
  })

  it('prefers the city over the region when it has both', () => {
    expect(resolveHere(cf({ city: 'Dharan', region: 'Kaski' })).city).toBe('Dharan')
  })

  it('reads the coordinate strings Cloudflare actually sends', () => {
    // `cf.latitude` is a string, not a number.
    expect(resolveHere(cf({ latitude: '28.2096', longitude: '83.9856' }))).toMatchObject({
      city: 'Pokhara', source: 'ip', in_nepal: true,
    })
  })

  it('ignores a coordinate that is not a number', () => {
    expect(resolveHere(cf({ latitude: 'unknown', longitude: '' }))).toMatchObject({
      city: 'Kathmandu', source: 'default', in_nepal: false,
    })
  })

  it('answers with the city centroid, never the IP coordinate', () => {
    // A geo-IP point is accurate to somewhere between a suburb and a province.
    // Opening the map on it would put the viewer in a field outside town while
    // telling them they are in Pokhara.
    const here = resolveHere(cf({ city: 'Pokhara', latitude: '28.1500', longitude: '83.9000' }))
    expect(here.lat).toBeCloseTo(28.2096, 4)
    expect(here.lng).toBeCloseTo(83.9856, 4)
  })

  it('tells a visitor in Kathmandu apart from one it could not place', () => {
    // Both get `city: 'Kathmandu'`. Only one of them is actually there, and
    // `source` is the entire difference.
    expect(resolveHere(cf({ city: 'Kathmandu' })).source).toBe('ip')
    expect(resolveHere(undefined).source).toBe('default')
  })

  it('does not claim a visitor outside Nepal is inside it', () => {
    // Delhi is nearer to Nepalgunj than most of Nepal is. The answer is the
    // default, and `in_nepal` says why.
    const delhi = resolveHere(cf({ city: 'Delhi', latitude: '28.6139', longitude: '77.2090' }))
    expect(delhi).toMatchObject({ city: 'Kathmandu', source: 'default', in_nepal: false })
  })

  it('places a coordinate inside Nepal even when the name means nothing', () => {
    // Somewhere in the hills with a name no alias list has.
    expect(resolveHere(cf({ city: 'Baglung', latitude: '28.27', longitude: '83.59' })))
      .toMatchObject({ source: 'ip', in_nepal: true })
  })

  it('never returns a city without both spellings', () => {
    for (const input of [undefined, cf({}), cf({ city: 'Ilam' }), cf({ region: 'Jhapa' })]) {
      const here = resolveHere(input)
      expect(here.city.length).toBeGreaterThan(0)
      expect(here.city_ne).toMatch(/^[ऀ-ॿ\s]+$/)
    }
  })
})
