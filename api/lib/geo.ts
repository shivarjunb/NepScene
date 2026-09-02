/** Ported from HeroLiveMap.tsx, which is where the distance chips already use it. */
const EARTH_RADIUS_KM = 6371

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export type BoundingBox = { minLat: number; maxLat: number; minLng: number; maxLng: number }

/**
 * A box that contains the circle, used to prefilter in SQL against the
 * (latitude, longitude) index before the exact haversine runs in the Worker.
 * SQLite has no trigonometry we can rely on across D1 builds.
 */
export function boundingBox(lat: number, lng: number, radiusKm: number): BoundingBox {
  const latDelta = radiusKm / 111.32
  const cos = Math.cos((lat * Math.PI) / 180)
  // Near the poles the longitude delta explodes; clamp to the whole range.
  const lngDelta = Math.abs(cos) < 0.01 ? 180 : radiusKm / (111.32 * cos)
  return {
    minLat: Math.max(-90, lat - latDelta),
    maxLat: Math.min(90, lat + latDelta),
    minLng: Math.max(-180, lng - lngDelta),
    maxLng: Math.min(180, lng + lngDelta),
  }
}
