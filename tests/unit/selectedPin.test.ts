import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { markerFor, planMarkers } from '../../app/map/clustering'
import type { MapPin } from '../../app/map/markers'
import {
  clusterSize, clusterSvg, pinSvg, PIN_SIZE, SELECTED_PIN_ANCHOR, SELECTED_PIN_SIZE,
  SELECTED_RING, selectedClusterDataUri, selectedClusterSize, selectedClusterSvg,
  selectedPinDataUri, selectedPinSvg,
} from '../../app/map/pinMarker'
import type { VenueGroup } from '../../app/map/venueGrouping'
import type { Bounds } from '../../app/map/viewport'
import { DEFAULT_PIN } from '../../api/catalog/pin'

/**
 * The marker whose card is open, picked out from the rest.
 *
 * The card opens across the top of the map rather than above its pin, so on
 * a busy map nothing said which pin it was about. The selected marker is
 * drawn larger and ringed in the site's accent (and set above its neighbours,
 * which is a z-index and is asserted end to end in mapSelectedPin.spec.ts).
 * What is asserted here is the drawing: that it is the same pin, larger, in
 * the right colour, pointing at the same place.
 */

const CONCERTS = { icon: 'Music', color: '#e91e63', category: 'concerts' }

/** The `viewBox` of an SVG string, as numbers. */
function viewBoxOf(svg: string) {
  const [x, y, width, height] = /viewBox="([^"]+)"/.exec(svg)![1]!.split(' ').map(Number)
  return { x: x!, y: y!, width: width!, height: height! }
}

/** `--accent` in the block that owns `selector`, followed through its var(). */
function accentIn(selector: string): string {
  const css = env.TOKENS_CSS
  const read = (block: string, name: string) =>
    new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim()
  const start = css.indexOf(selector)
  const block = css.slice(css.indexOf('{', start), css.indexOf('\n}', start))
  const accent = read(block, '--accent')!
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(accent)
  // The palette lives in the light block, which every theme inherits.
  return reference ? read(css, reference[1]!)! : accent
}

describe('a selected pin is the same pin, picked out', () => {
  it('is drawn larger than a resting one', () => {
    expect(SELECTED_PIN_SIZE).toBeGreaterThan(PIN_SIZE)
    const svg = selectedPinSvg(CONCERTS)
    expect(svg).toContain(`width="${SELECTED_PIN_SIZE}"`)
    expect(svg).toContain(`height="${SELECTED_PIN_SIZE}"`)
  })

  it('is ringed in the accent, with white outside the ring', () => {
    const svg = selectedPinSvg(CONCERTS)
    expect(svg).toContain(`stroke="${SELECTED_RING.light}"`)
    // The halo, and the ring along the teardrop's edge.
    expect(svg).toContain(`fill="${SELECTED_RING.light}" opacity="0.3"`)
    // White first and wider, so it shows outside the accent: the tiles under
    // a pin are not ours, and the accent alone is lost on some of them.
    const white = svg.indexOf('stroke="#ffffff" stroke-width="12"')
    const accent = svg.indexOf(`stroke="${SELECTED_RING.light}" stroke-width="8"`)
    expect(white).toBeGreaterThan(-1)
    expect(accent).toBeGreaterThan(white)
  })

  it('wears the accent of the theme it is drawn for', () => {
    expect(selectedPinSvg(CONCERTS, 1, 'dark')).toContain(`stroke="${SELECTED_RING.dark}"`)
    expect(selectedPinSvg(CONCERTS, 1, 'dark')).not.toContain(SELECTED_RING.light)
    expect(selectedPinSvg(CONCERTS, 1, 'light')).not.toContain(SELECTED_RING.dark)
  })

  it('draws the resting pin inside the ring, glyph, colour and count included', () => {
    // Picking a pin out must never change which pin it is.
    for (const count of [1, 6]) {
      const resting = pinSvg(CONCERTS, count)
      const inner = resting.slice(resting.indexOf('>') + 1, -'</svg>'.length)
      const selected = selectedPinSvg(CONCERTS, count)
      // The stacked shadow comes first, then the ring, then the pin in front.
      if (count > 1) {
        const [shadow, front] = inner.split(/(?=<path d="M20 3c[^"]*" fill)/)
        expect(selected).toContain(shadow!)
        expect(selected).toContain(front!)
      } else {
        expect(selected).toContain(inner)
      }
    }
    expect(selectedPinSvg(CONCERTS, 6)).toContain('>6</text>')
  })

  it('leaves the resting pin alone', () => {
    const resting = pinSvg(CONCERTS)
    expect(resting).not.toContain(SELECTED_RING.light)
    expect(resting).not.toContain(SELECTED_RING.dark)
    expect(resting).toContain('viewBox="0 0 40 40"')
  })

  it('points at the same place a resting pin does', () => {
    // The resting pin is anchored at the bottom-centre of its 40×40 box. The
    // selected pin's anchor, carried back into the same units, must land on
    // that same point — otherwise the pin slides when it is tapped.
    const box = viewBoxOf(selectedPinSvg(DEFAULT_PIN))
    const unitsPerPixel = box.width / SELECTED_PIN_SIZE
    expect(box.x + SELECTED_PIN_ANCHOR.x * unitsPerPixel).toBeCloseTo(PIN_SIZE / 2)
    expect(box.y + SELECTED_PIN_ANCHOR.y * unitsPerPixel).toBeCloseTo(PIN_SIZE)
    expect(SELECTED_PIN_ANCHOR.x).toBeCloseTo(SELECTED_PIN_SIZE / 2)
  })

  it('has room in its box for the ring round the point', () => {
    // The teardrop's point is at y=37, and the ring is 6 units wide outside it.
    const box = viewBoxOf(selectedPinSvg(DEFAULT_PIN))
    expect(box.y + box.height).toBeGreaterThanOrEqual(37 + 6)
  })

  it('is a data URI of the same drawing', () => {
    const uri = selectedPinDataUri(CONCERTS, 3, 'dark')
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(uri.split(',')[1]!)).toBe(selectedPinSvg(CONCERTS, 3, 'dark'))
  })
})

describe('the ring is the site accent, and cannot drift from it', () => {
  it('is --accent in the light theme', () => {
    expect(SELECTED_RING.light).toBe(accentIn(':root {'))
  })

  it('is --accent in the dark theme', () => {
    expect(SELECTED_RING.dark).toBe(accentIn(":root[data-theme='dark']"))
  })
})

describe('a selected bubble, for the stacks no zoom can separate', () => {
  it('is larger than its resting bubble at every size', () => {
    for (const count of [2, 150, 800]) {
      expect(selectedClusterSize(count)).toBeGreaterThan(clusterSize(count))
      expect(selectedClusterSvg(count)).toContain(`width="${selectedClusterSize(count)}"`)
    }
  })

  it('carries the accent ring and still says how many', () => {
    const svg = selectedClusterSvg(7, 'dark')
    expect(svg).toContain(`stroke="${SELECTED_RING.dark}"`)
    expect(svg).toContain('>7</text>')
    expect(clusterSvg(7)).not.toContain(SELECTED_RING.dark)
  })

  it('is a data URI of the same drawing', () => {
    const uri = selectedClusterDataUri(12)
    expect(decodeURIComponent(uri.split(',')[1]!)).toBe(selectedClusterSvg(12))
  })
})

describe('the selected marker is found by place, not held by reference', () => {
  const VIEWPORT: Bounds = { west: 85.20, south: 27.60, east: 85.44, north: 27.84 }
  const OVERLAP = { lat: 0.005, lng: 0.005 }
  const group = (key: string, lat: number, lng: number, count = 1): VenueGroup => ({
    key, lat, lng, count, pins: [] as unknown as MapPin[], primary: {} as MapPin,
  })

  it('finds a place drawn as its own pin, whatever its count now is', () => {
    const before = planMarkers([group('purple', 27.72, 85.31, 2)], VIEWPORT, { overlap: OVERLAP })
    const after = planMarkers([group('purple', 27.72, 85.31, 3)], VIEWPORT, { overlap: OVERLAP })
    expect(markerFor(before, 'purple')).toEqual({ kind: 'group', group: before.groups[0] })
    // Redrawn with a new number, which is a new marker: still found.
    expect(markerFor(after, 'purple')).toMatchObject({ kind: 'group', group: { count: 3 } })
  })

  it('finds a place inside the bubble it has been merged into', () => {
    const plan = planMarkers([
      group('cafe', 27.72, 85.320),
      group('hall', 27.72, 85.3201),
    ], VIEWPORT, { overlap: OVERLAP })
    const found = markerFor(plan, 'hall')
    expect(found?.kind).toBe('cluster')
    expect(found?.kind === 'cluster' && found.cluster.groups.map((g) => g.key).sort())
      .toEqual(['cafe', 'hall'])
  })

  it('finds nothing for a place that is off screen', () => {
    const plan = planMarkers([group('far', 28.2, 83.95)], VIEWPORT, { overlap: OVERLAP })
    expect(markerFor(plan, 'far')).toBeNull()
  })
})
