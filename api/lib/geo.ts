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

/** Kilometres per degree of latitude. Constant enough at any latitude. */
const KM_PER_DEGREE = 111.32

/**
 * The circle itself, as three numbers SQL can multiply.
 *
 * SQLite has no trigonometry we can rely on across D1 builds, so the exact
 * haversine cannot run in the query — but the *flat-earth* approximation can,
 * because it is only multiplication once the two scale factors are computed
 * here. Over a 500km radius at Nepal's latitudes it disagrees with haversine
 * by well under a tenth of a percent, which is metres.
 *
 * Applying it in SQL rather than in the Worker is what keeps a distance search
 * honest: the rows the reader sees and the facet counts beside them come from
 * the same WHERE. Cutting the circle in the Worker afterwards would leave the
 * counts describing the bounding box instead — a rectangle 27% larger than the
 * circle inside it.
 */
export type Circle = {
  lat: number
  lng: number
  /** Squared km per degree, latitude and longitude, at this centre. */
  latScale: number
  lngScale: number
  radiusKmSquared: number
}

export function circleOf(lat: number, lng: number, radiusKm: number): Circle {
  const cos = Math.cos((lat * Math.PI) / 180)
  return {
    lat,
    lng,
    latScale: KM_PER_DEGREE ** 2,
    lngScale: (KM_PER_DEGREE * cos) ** 2,
    radiusKmSquared: radiusKm ** 2,
  }
}

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
