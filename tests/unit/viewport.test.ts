import { describe, expect, it } from 'vitest'
import {
  bboxParam, contains, MAX_SPAN_DEGREES, needsFetch, padBounds, PAD_RATIO, sameBounds,
  tooWide, within, type Bounds,
} from '../../app/map/viewport'
import { parseViewport } from '../../api/catalog/shared'

/**
 * The map's half of #36: what the viewport becomes, and when it is asked for.
 *
 * The acceptance criterion these serve is "panning loads listings for the new
 * viewport without refetching everything". That is a claim about `needsFetch`
 * and `padBounds` together, and it is checkable here without a key, an SDK or
 * a canvas — which is the reason the decisions live in their own module.
 */

/** The Kathmandu valley, roughly what the map opens on. */
const VALLEY: Bounds = { west: 85.24, south: 27.64, east: 85.42, north: 27.78 }

const shifted = (bounds: Bounds, dLng: number, dLat = 0): Bounds => ({
  west: bounds.west + dLng,
  east: bounds.east + dLng,
  south: bounds.south + dLat,
  north: bounds.north + dLat,
})

describe('bbox parameters', () => {
  it('serialises west,south,east,north — the order the API parses', () => {
    expect(bboxParam(VALLEY)).toBe('85.24,27.64,85.42,27.78')
  })

  /**
   * The one test that matters most in this file. The client writes the order
   * and the Worker reads it, in two files that never import each other; the
   * only thing that can keep them agreeing is an assertion that runs both.
   */
  it('round-trips through the API parser with the axes still the right way up', () => {
    const url = new URL(`https://nepscene.test/api/catalog/search?bbox=${bboxParam(VALLEY)}`)
    expect(parseViewport(url)).toEqual({
      minLng: VALLEY.west,
      minLat: VALLEY.south,
      maxLng: VALLEY.east,
      maxLat: VALLEY.north,
    })
  })

  it('rounds to five decimals so two viewers of one place share a cache key', () => {
    const fussy: Bounds = {
      west: 85.240000001, south: 27.6400000009, east: 85.42, north: 27.78,
    }
    expect(bboxParam(fussy)).toBe('85.24,27.64,85.42,27.78')
  })
})

describe('the fetched box is larger than the viewport', () => {
  it('pads by the ratio on every side', () => {
    const padded = padBounds(VALLEY)
    const latPad = (VALLEY.north - VALLEY.south) * PAD_RATIO
    expect(padded.north).toBeCloseTo(VALLEY.north + latPad, 10)
    expect(padded.south).toBeCloseTo(VALLEY.south - latPad, 10)
    expect(contains(padded, VALLEY)).toBe(true)
  })

  it('clamps at the edges of the world rather than wrapping', () => {
    const polar = padBounds({ west: -179, south: 88, east: 179, north: 90 })
    expect(polar.north).toBeLessThanOrEqual(90)
    expect(polar.west).toBeGreaterThanOrEqual(-180)
    expect(polar.east).toBeLessThanOrEqual(180)
  })
})

describe('when a pan costs a request', () => {
  it('fetches when nothing is loaded yet', () => {
    expect(needsFetch(null, VALLEY)).toBe(true)
  })

  it('does not refetch for a nudge inside the padded box', () => {
    const loaded = padBounds(VALLEY)
    // A hundredth of a degree is about a kilometre — well inside a quarter of
    // the valley's 0.18° width.
    expect(needsFetch(loaded, shifted(VALLEY, 0.01))).toBe(false)
  })

  it('refetches once the viewport leaves the box', () => {
    const loaded = padBounds(VALLEY)
    expect(needsFetch(loaded, shifted(VALLEY, 0.5))).toBe(true)
  })

  it('refetches on zoom out, which leaves the box the same way a pan does', () => {
    const loaded = padBounds(VALLEY)
    const zoomedOut: Bounds = { west: 84.9, south: 27.3, east: 85.8, north: 28.1 }
    expect(needsFetch(loaded, zoomedOut)).toBe(true)
  })

  it('does not refetch on zoom in, whose rows are a subset of what is held', () => {
    const loaded = padBounds(VALLEY)
    const zoomedIn: Bounds = { west: 85.30, south: 27.70, east: 85.33, north: 27.73 }
    expect(needsFetch(loaded, zoomedIn)).toBe(false)
  })
})

describe('a viewport too wide to mean anything', () => {
  it('accepts the whole country', () => {
    // Nepal is about 800km north to south, well under the span limit.
    expect(tooWide({ west: 80.0, south: 26.3, east: 88.2, north: 30.5 })).toBe(false)
  })

  it('rejects a view of the subcontinent, where "in view" is "everything"', () => {
    expect(tooWide({ west: 68, south: 8, east: 97, north: 36 })).toBe(true)
  })

  it('draws the line at the documented span', () => {
    expect(tooWide({ west: 85, south: 0, east: 86, north: MAX_SPAN_DEGREES + 0.1 })).toBe(true)
    expect(tooWide({ west: 85, south: 0, east: 86, north: MAX_SPAN_DEGREES - 0.1 })).toBe(false)
  })
})

describe('parseViewport rejects what it cannot honestly answer', () => {
  const parse = (bbox: string) =>
    () => parseViewport(new URL(`https://nepscene.test/x?bbox=${bbox}`))

  it('is absent when no bbox is given', () => {
    expect(parseViewport(new URL('https://nepscene.test/x'))).toBeUndefined()
  })

  it.each([
    ['85.2,27.6,85.4', 'three values'],
    ['85.2,27.6,85.4,27.8,1', 'five values'],
    ['a,b,c,d', 'not numbers'],
    ['85.2,-91,85.4,27.8', 'a latitude off the planet'],
    ['-181,27.6,85.4,27.8', 'a longitude off the planet'],
    ['85.2,27.8,85.4,27.6', 'south above north'],
  ])('rejects %s (%s)', (bbox) => {
    expect(parse(bbox)).toThrow()
  })

  /**
   * A box with west > east wraps the antimeridian, which one SQL `BETWEEN`
   * cannot express. Answering it with the inverse region — everything *except*
   * what was asked for — is the failure mode worth a test.
   */
  it('rejects an antimeridian crossing rather than inverting it', () => {
    expect(parse('179,27.6,-179,27.8')).toThrow(/antimeridian/)
  })
})

describe('what is actually on screen', () => {
  /**
   * The map keeps pins across pans, so the number it holds and the number in
   * front of the viewer diverge the moment anybody moves. The status line
   * claims the second, so it has to count the second.
   */
  it('counts a pin inside the viewport', () => {
    expect(within(VALLEY, { lat: 27.7154, lng: 85.3105 })).toBe(true)
  })

  it('does not count a pin left over from somewhere else', () => {
    // Pokhara, still held from a previous viewport and still on the map.
    expect(within(VALLEY, { lat: 28.2096, lng: 83.9556 })).toBe(false)
  })

  it('counts a pin exactly on the edge', () => {
    expect(within(VALLEY, { lat: VALLEY.north, lng: VALLEY.east })).toBe(true)
  })
})


/**
 * `idle` fires for more than pans — a resize, a programmatic `setCenter` to
 * where the map already is, the SDK settling after tiles load. Each hands back
 * bounds, and storing a fresh object for identical numbers restarts the fetch
 * effect: it aborts the request already in flight for that box and issues the
 * same one again. This is the comparison that stops it.
 */
describe('the same rectangle is the same rectangle', () => {
  const box: Bounds = { west: 85.2, south: 27.6, east: 85.4, north: 27.8 }

  it('is true for equal numbers in a different object', () => {
    expect(sameBounds({ ...box }, box)).toBe(true)
  })

  it('is false when any edge moved', () => {
    expect(sameBounds({ ...box, west: 85.21 }, box)).toBe(false)
    expect(sameBounds({ ...box, east: 85.41 }, box)).toBe(false)
    expect(sameBounds({ ...box, south: 27.61 }, box)).toBe(false)
    expect(sameBounds({ ...box, north: 27.81 }, box)).toBe(false)
  })

  it('is false against nothing loaded yet', () => {
    expect(sameBounds(null, box)).toBe(false)
  })
})
