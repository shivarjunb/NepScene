import { describe, expect, it } from 'vitest'
import { CLUSTER_THRESHOLD, planMarkers } from '../../app/map/clustering'
import { mergePins, type MapPin } from '../../app/map/markers'
import type { VenueGroup } from '../../app/map/venueGrouping'
import type { Bounds } from '../../app/map/viewport'
import { clusterSize, CLUSTER_SIZES } from '../../app/map/pinMarker'

/**
 * #39's unit criteria: "clustering thresholds trigger at the intended zoom
 * levels", and the virtualisation that goes with it.
 *
 * The thing being defended is a marker count that grows with the catalogue or
 * with how long somebody has been panning, rather than with what is on screen.
 * WaahTickets rendered every published event as a rich HTML marker, which is
 * fine at fifty and unusable at five thousand — and the ceiling was lower than
 * it looked, because the markers were DOM rather than sprites.
 */

const VIEWPORT: Bounds = { west: 85.20, south: 27.60, east: 85.44, north: 27.84 }

const group = (lat: number, lng: number, count = 1, key = `${lat},${lng}`): VenueGroup => ({
  key, lat, lng, count,
  pins: [] as unknown as MapPin[],
  primary: {} as MapPin,
})

/** `n` places spread evenly across the viewport. */
const spread = (n: number, box: Bounds = VIEWPORT): VenueGroup[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n
    return group(
      box.south + (box.north - box.south) * ((i * 7 % n) / n),
      box.west + (box.east - box.west) * t,
      1,
      `v${i}`,
    )
  })

describe('only what is on screen gets a marker', () => {
  it('drops everything outside the viewport', () => {
    const plan = planMarkers([
      group(27.72, 85.32, 1, 'in'),
      group(28.21, 83.96, 1, 'pokhara'),
    ], VIEWPORT)

    expect(plan.kind).toBe('groups')
    expect(plan.groups.map((g) => g.key)).toEqual(['in'])
  })

  it('draws nothing at all before there is a viewport', () => {
    const plan = planMarkers(spread(10), null)
    expect(plan.groups).toEqual([])
    expect(plan.clusters).toEqual([])
  })

  it('keeps a marker count bounded by the screen, not by the held set', () => {
    // The held set is what makes a pan smooth; it is not what should be drawn.
    const held = [...spread(40), ...Array.from({ length: 5000 }, (_, i) =>
      group(20 + i * 0.001, 60 + i * 0.001, 1, `far${i}`))]
    const plan = planMarkers(held, VIEWPORT)
    expect(plan.groups).toHaveLength(40)
  })
})

describe('clustering above a density threshold', () => {
  it('draws places while there are few enough of them to read', () => {
    const plan = planMarkers(spread(CLUSTER_THRESHOLD), VIEWPORT)
    expect(plan.kind).toBe('groups')
    expect(plan.groups).toHaveLength(CLUSTER_THRESHOLD)
  })

  it('switches to clusters one past the threshold', () => {
    const plan = planMarkers(spread(CLUSTER_THRESHOLD + 1), VIEWPORT)
    expect(plan.kind).toBe('clusters')
    expect(plan.groups).toEqual([])
    expect(plan.clusters.length).toBeGreaterThan(0)
  })

  it('caps the marker count however dense the catalogue gets', () => {
    // The point of the whole module. Ten thousand places on one screen is 144
    // bubbles at most — a 12×12 grid — and in practice far fewer.
    for (const n of [200, 2_000, 10_000]) {
      const plan = planMarkers(spread(n), VIEWPORT)
      expect(plan.kind).toBe('clusters')
      expect(plan.clusters.length).toBeLessThanOrEqual(144)
    }
  })

  it('loses no listings: the bubbles add up to what is in view', () => {
    const groups = spread(500).map((g, i) => ({ ...g, count: (i % 3) + 1 }))
    const plan = planMarkers(groups, VIEWPORT)
    const clustered = plan.clusters.reduce((sum, cluster) => sum + cluster.count, 0)
    expect(clustered).toBe(groups.reduce((sum, g) => sum + g.count, 0))
  })

  it('counts listings rather than venues, so a bubble saying 9 means nine things', () => {
    const groups = spread(100).map((g) => ({ ...g, count: 4 }))
    const plan = planMarkers(groups, VIEWPORT)
    expect(plan.clusters.reduce((sum, c) => sum + c.count, 0)).toBe(400)
  })
})

describe('the grid is derived from the viewport, so it follows the zoom', () => {
  /**
   * The same places, at two zoom levels. Reading `getZoom()` and switching on
   * integer levels — the usual approach — produces a visible jump at each
   * level and behaves differently on a phone and a desktop, which have very
   * different spans at the same zoom.
   */
  /** 400 places packed into a small patch, so both viewports below hold all of them. */
  const PATCH: Bounds = { west: 85.30, south: 27.70, east: 85.32, north: 27.72 }
  const places = spread(400, PATCH)

  it('splits the same places into more clusters as the viewport narrows', () => {
    // Same input, two viewports, one twelve times the span of the other. The
    // tighter one has cells a twelfth the size, so the same places land in
    // more distinct cells — which is what "zoom in and it opens up" means,
    // arrived at without ever reading `map.getZoom()`.
    const wide = planMarkers(places, VIEWPORT)
    const tight = planMarkers(places, PATCH)

    expect(wide.kind).toBe('clusters')
    expect(tight.kind).toBe('clusters')
    expect(tight.clusters.length).toBeGreaterThan(wide.clusters.length)
  })

  it('opens into places once few enough of them are left in view', () => {
    // The other half of the same behaviour: keep zooming and the bubbles
    // become the pins they were standing for.
    const zoomed = planMarkers(places, {
      west: 85.3000, south: 27.7000, east: 85.3010, north: 27.7010,
    })
    expect(zoomed.kind).toBe('groups')
    expect(zoomed.groups.length).toBeLessThanOrEqual(CLUSTER_THRESHOLD)
  })

  it('puts a bubble at the centroid of what it holds, not at its cell centre', () => {
    // A bubble sitting in a lake because that is where the grid line fell is
    // worse than no bubble.
    const cluster = planMarkers(spread(200), VIEWPORT).clusters[0]!
    const lats = cluster.groups.map((g) => g.lat)
    expect(cluster.lat).toBeGreaterThanOrEqual(Math.min(...lats))
    expect(cluster.lat).toBeLessThanOrEqual(Math.max(...lats))
  })

  it('survives a viewport with no span rather than dividing by zero', () => {
    const flat: Bounds = { west: 85.3, south: 27.7, east: 85.3, north: 27.7 }
    const plan = planMarkers(
      Array.from({ length: 100 }, (_, i) => group(27.7, 85.3, 1, `v${i}`)),
      flat,
    )
    expect(plan.kind).toBe('clusters')
    expect(plan.clusters).toHaveLength(1)
    expect(Number.isFinite(plan.clusters[0]!.lat)).toBe(true)
  })
})

describe('the bubble grows in steps, not continuously', () => {
  it('takes one of three sizes', () => {
    for (const count of [1, 60, 99, 100, 400, 500, 9999]) {
      expect(CLUSTER_SIZES).toContain(clusterSize(count))
    }
  })

  it('never shrinks as the count rises', () => {
    // Two bubbles of 40 and 44 should not look meaningfully different; two of
    // 40 and 4,000 should.
    let previous = 0
    for (const count of [1, 50, 99, 100, 250, 499, 500, 5000]) {
      const size = clusterSize(count)
      expect(size).toBeGreaterThanOrEqual(previous)
      previous = size
    }
  })
})

describe('the held set is bounded', () => {
  it('keeps everything below the limit', () => {
    const pins = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}` } as MapPin))
    expect(mergePins([], pins, 100)).toHaveLength(30)
  })

  it('drops the oldest past the limit, rather than growing forever', () => {
    // Pan across Nepal for a minute and an unbounded set is every listing in
    // the country — the unbounded read the Catalog API exists to prevent,
    // arrived at one viewport at a time.
    const pins = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}` } as MapPin))
    const held = mergePins([], pins, 100)
    expect(held).toHaveLength(100)
    expect(held[0]!.id).toBe('p400')
    expect(held[99]!.id).toBe('p499')
  })

  it('treats a pin the current viewport returned as the newest, not the oldest', () => {
    // Otherwise the pins the viewer is looking at are the first to be evicted,
    // which is precisely backwards.
    const old = Array.from({ length: 5 }, (_, i) => ({ id: `old${i}` } as MapPin))
    const held = mergePins(old, [{ id: 'old0' } as MapPin, { id: 'new' } as MapPin], 3)
    expect(held.map((pin) => pin.id)).toEqual(['old4', 'old0', 'new'])
  })

  it('is unbounded when no limit is given, which is what every other caller wants', () => {
    const pins = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}` } as MapPin))
    expect(mergePins([], pins)).toHaveLength(1000)
  })
})
