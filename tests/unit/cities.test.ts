import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CITY, inNepal, nearestCity, NEPAL_CITIES, resolveCity,
} from '../../api/lib/cities'
import { haversineKm } from '../../api/lib/geo'

/**
 * #38's unit criteria: "city detection matches all twenty aliases and falls
 * back to nearest by haversine", and "haversine distance is correct against
 * known city pairs".
 *
 * The table came across from WaahTickets unchanged, so what is worth testing
 * is not the numbers in it but the resolution rules around it — and one rule
 * the original did not have: a visitor outside Nepal is not told they are in
 * the nearest Nepali city.
 */

describe('the twenty cities', () => {
  it('has twenty of them', () => {
    expect(NEPAL_CITIES).toHaveLength(20)
  })

  it('names Kathmandu as the default', () => {
    expect(DEFAULT_CITY.name).toBe('Kathmandu')
    expect(DEFAULT_CITY.name_ne).toBe('काठमाडौं')
  })

  it('carries a Devanagari name for every city (#46)', () => {
    // A headline reading "Kathmandu वरिपरि के-के भइरहेको छ" is half-translated,
    // and the city is the word in it a Nepali reader is most likely to expect
    // in Devanagari.
    for (const city of NEPAL_CITIES) {
      expect(city.name_ne, city.name).toMatch(/^[\u0900-\u097F\s]+$/)
    }
  })

  it('resolves every alias in the table to its own city', () => {
    for (const city of NEPAL_CITIES) {
      for (const alias of city.aliases) {
        expect(resolveCity(alias, null, null).name).toBe(city.name)
      }
    }
  })

  it('carries no alias that resolves to a different city than its own', () => {
    // The failure this catches is a new alias that is a substring of an
    // earlier city's alias, which would be shadowed and never reached — and
    // silently, because the wrong city is still *a* city.
    for (const city of NEPAL_CITIES) {
      for (const alias of city.aliases) {
        expect(`${city.name}:${alias} -> ${resolveCity(alias, null, null).name}`)
          .toBe(`${city.name}:${alias} -> ${city.name}`)
      }
    }
  })

  it('matches a longer name that contains an alias', () => {
    // What a geo-IP provider actually returns.
    expect(resolveCity('Kathmandu Metropolitan City', null, null).name).toBe('Kathmandu')
    expect(resolveCity('POKHARA', null, null).name).toBe('Pokhara')
    expect(resolveCity('  Bhadgaon  ', null, null).name).toBe('Bhaktapur')
  })

  it('falls back to the nearest city by haversine when no name matches', () => {
    // Sankhu: inside the valley, in no alias list, and nearest to Kathmandu.
    expect(resolveCity('Sankhu', 27.7500, 85.4600, ).name).toBe('Bhaktapur')
    // Beside Phewa Tal, which nothing is named after.
    expect(resolveCity('Somewhere', 28.2100, 83.9600).name).toBe('Pokhara')
  })

  it('falls back to the nearest city when there is no name at all', () => {
    expect(resolveCity(null, 26.4600, 87.2700).name).toBe('Biratnagar')
    expect(resolveCity(undefined, 27.7172, 85.3240).name).toBe('Kathmandu')
  })

  it('does not name a Nepali city for somebody who is not in Nepal', () => {
    // Delhi is nearer to Nepalgunj than most of Nepal is, and telling a
    // visitor there that they are in Nepalgunj is a lie rather than a guess.
    expect(resolveCity(null, 28.6139, 77.2090).name).toBe('Kathmandu')
    expect(resolveCity('Delhi', 28.6139, 77.2090).name).toBe('Kathmandu')
    // London: no coordinate is near anything.
    expect(resolveCity('London', 51.5, -0.12).name).toBe('Kathmandu')
  })

  it('knows the box it is willing to guess inside', () => {
    expect(inNepal(27.7172, 85.3240)).toBe(true)
    expect(inNepal(28.6139, 77.2090)).toBe(false)
    expect(inNepal(51.5, -0.12)).toBe(false)
  })

  it('returns a city for any coordinate inside Nepal', () => {
    for (const lat of [26.4, 27.5, 28.5, 30.4]) {
      for (const lng of [80.0, 83.0, 85.0, 88.1]) {
        expect(NEPAL_CITIES).toContain(nearestCity(lat, lng))
      }
    }
  })
})

describe('haversine, against known pairs', () => {
  /**
   * Great-circle distances between the table's own centroids, to the tenth of
   * a kilometre. These are what a correct haversine returns for these
   * coordinates — not what the road between the two cities measures, which is
   * longer and is a different question.
   */
  const pairs: [string, string, number][] = [
    ['Kathmandu', 'Pokhara', 142.4],
    ['Kathmandu', 'Lalitpur', 6.5],
    ['Kathmandu', 'Biratnagar', 238.7],
    ['Kathmandu', 'Dhangadhi', 476.8],
    ['Pokhara', 'Butwal', 77.3],
  ]

  const city = (name: string) => NEPAL_CITIES.find((c) => c.name === name)!

  it.each(pairs)('%s to %s is %skm', (a, b, expected) => {
    const from = city(a)
    const to = city(b)
    // A tenth of a kilometre. The formula is exact arithmetic on fixed
    // inputs, so a loose tolerance here would let a real error through — the
    // flat-earth approximation in `circleOf`, for instance, agrees with this
    // to well within a percent and is a different function.
    expect(haversineKm(from.lat, from.lng, to.lat, to.lng)).toBeCloseTo(expected, 1)
  })

  it('is zero for a point and itself', () => {
    expect(haversineKm(27.7172, 85.324, 27.7172, 85.324)).toBe(0)
  })

  it('is symmetric', () => {
    const there = haversineKm(27.7172, 85.324, 28.2096, 83.9856)
    const back = haversineKm(28.2096, 83.9856, 27.7172, 85.324)
    expect(there).toBeCloseTo(back, 9)
  })
})

/**
 * #38's third unit criterion: "distance filtering includes and excludes at the
 * boundary correctly". The filter itself is one `<=` in NepalMap; what is
 * worth pinning is which side of it the boundary falls on.
 */
describe('the distance boundary', () => {
  const CENTRE = { lat: 27.7172, lng: 85.324 }
  const within = (lat: number, lng: number, radiusKm: number) =>
    haversineKm(CENTRE.lat, CENTRE.lng, lat, lng) <= radiusKm

  /** A point exactly `km` due north of the centre. 1° of latitude ≈ 111.32km. */
  const north = (km: number) => ({ lat: CENTRE.lat + km / 111.195, lng: CENTRE.lng })

  it('includes a listing exactly on the ring', () => {
    const at = north(5)
    expect(haversineKm(CENTRE.lat, CENTRE.lng, at.lat, at.lng)).toBeCloseTo(5, 2)
    expect(within(at.lat, at.lng, 5)).toBe(true)
  })

  it('excludes a listing just outside it', () => {
    const at = north(5.01)
    expect(within(at.lat, at.lng, 5)).toBe(false)
  })

  it('includes a listing just inside it', () => {
    const at = north(4.99)
    expect(within(at.lat, at.lng, 5)).toBe(true)
  })

  it('includes the centre itself at every radius', () => {
    for (const km of [2, 5, 10, 20, 100]) {
      expect(within(CENTRE.lat, CENTRE.lng, km)).toBe(true)
    }
  })

  it('is nested — a 2km match is also a 5km match', () => {
    const at = north(1.5)
    for (const km of [2, 5, 10, 20, 100]) expect(within(at.lat, at.lng, km)).toBe(true)
  })
})
