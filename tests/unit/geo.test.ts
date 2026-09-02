import { describe, expect, it } from 'vitest'
import { boundingBox, haversineKm } from '../../api/lib/geo'

const THAMEL = { lat: 27.7154, lng: 85.3105 }
const POKHARA = { lat: 28.2096, lng: 83.9556 }

describe('haversineKm', () => {
  it('measures Kathmandu to Pokhara at the known ~140km', () => {
    const km = haversineKm(THAMEL.lat, THAMEL.lng, POKHARA.lat, POKHARA.lng)
    expect(km).toBeGreaterThan(135)
    expect(km).toBeLessThan(145)
  })

  it('is zero for the same point', () => {
    expect(haversineKm(THAMEL.lat, THAMEL.lng, THAMEL.lat, THAMEL.lng)).toBe(0)
  })
})

describe('boundingBox', () => {
  it('contains the circle it approximates', () => {
    const box = boundingBox(THAMEL.lat, THAMEL.lng, 10)
    // A point exactly 9km north is inside the circle, so it must be in the box.
    const northLat = THAMEL.lat + 9 / 111.32
    expect(northLat).toBeGreaterThan(box.minLat)
    expect(northLat).toBeLessThan(box.maxLat)
  })

  it('clamps rather than wrapping near the poles', () => {
    const box = boundingBox(89.9, 0, 100)
    expect(box.maxLat).toBeLessThanOrEqual(90)
    expect(box.minLng).toBeGreaterThanOrEqual(-180)
    expect(box.maxLng).toBeLessThanOrEqual(180)
  })
})
