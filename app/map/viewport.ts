/**
 * Turning what the map is looking at into what the API is asked for (#36).
 *
 * This is the half of the map that has no Google in it, which is why it is its
 * own file: the interesting decisions here — when to refetch, how much to
 * over-fetch, how many digits to send — are all testable without an SDK, a
 * key, or a canvas.
 *
 * The rule the whole module exists to serve: **panning must not refetch what
 * is already on screen.** WaahTickets loaded every published event once and
 * kept it in memory, which is unbounded but at least never re-asked. Naively
 * fetching the exact viewport on every `idle` would be bounded but would fire
 * a request for a twenty-metre nudge. Neither is right; a padded box that is
 * only refetched once the viewport leaves it is.
 */

export type Bounds = { west: number; south: number; east: number; north: number }

/**
 * How much larger than the viewport the fetched box is, per side, as a
 * fraction of the viewport's own span. 0.25 means a box half again as wide as
 * the screen, so a quarter-screen pan in any direction is already loaded.
 *
 * Higher wastes rows the user never sees; lower refetches on small drags. A
 * quarter covers the ordinary "nudge the map to see what is behind the
 * popup" gesture, which is the one that would otherwise refetch constantly.
 */
export const PAD_RATIO = 0.25

/**
 * Coordinates are sent at five decimals — about a metre at this latitude.
 *
 * This is a cache decision more than a precision one. The bbox is part of the
 * edge cache key, so full float precision would make every request unique and
 * the cache useless; rounding means two people looking at the same place ask
 * the same question. A metre is far below the size of anything on the map.
 */
const PRECISION = 5

const round = (n: number) => Number(n.toFixed(PRECISION))

/** Grow a box by {@link PAD_RATIO} on each side, clamped to the real world. */
export function padBounds(bounds: Bounds, ratio: number = PAD_RATIO): Bounds {
  const latPad = (bounds.north - bounds.south) * ratio
  const lngPad = (bounds.east - bounds.west) * ratio
  return {
    south: Math.max(-90, bounds.south - latPad),
    north: Math.min(90, bounds.north + latPad),
    west: Math.max(-180, bounds.west - lngPad),
    east: Math.min(180, bounds.east + lngPad),
  }
}

/**
 * `bbox=west,south,east,north` — OGC/GeoJSON order, matching `parseViewport`
 * in `api/catalog/shared.ts`. The two orders must agree, and the test that
 * pins this one is the only thing that keeps them agreeing.
 */
export function bboxParam(bounds: Bounds): string {
  return [bounds.west, bounds.south, bounds.east, bounds.north].map(round).join(',')
}

/**
 * Are these the same rectangle?
 *
 * `idle` fires for reasons other than a pan — a resize, a programmatic
 * `setCenter` to where the map already is, the SDK settling after tiles load —
 * and each one hands back bounds. Storing a fresh object for identical numbers
 * restarts every effect that watches the viewport, which aborts an in-flight
 * fetch and issues it again. So identity is compared on the numbers.
 */
export function sameBounds(a: Bounds | null, b: Bounds): boolean {
  return a !== null
    && a.west === b.west && a.east === b.east
    && a.south === b.south && a.north === b.north
}

/** Is `inner` wholly inside `outer`? Touching edges count as inside. */
export function contains(outer: Bounds, inner: Bounds): boolean {
  return outer.west <= inner.west
    && outer.east >= inner.east
    && outer.south <= inner.south
    && outer.north >= inner.north
}

/**
 * The decision the `idle` handler asks on every pan, zoom and resize.
 *
 * Nothing is loaded yet, or the viewport has moved outside the padded box that
 * was fetched for it. Zooming *out* leaves the box the same way panning does,
 * so this covers both; zooming in never does, which is correct — the rows for
 * a smaller area are a subset of the ones already held.
 */
export function needsFetch(loaded: Bounds | null, viewport: Bounds): boolean {
  return loaded === null || !contains(loaded, viewport)
}

/**
 * A viewport big enough that scoping the query to it is a fiction.
 *
 * Zoomed out to the whole subcontinent, "listings in view" is every listing
 * there is, and the request is the unbounded catalogue fetch the Catalog API
 * was built to prevent — dressed up in a bbox. The map says so and asks the
 * viewer to zoom in rather than quietly returning the first fifty of
 * everything and letting them believe that is what is out there.
 *
 * 12° of latitude is roughly 1,300km: Nepal end to end is about 800km, so the
 * whole country still draws.
 */
export const MAX_SPAN_DEGREES = 12

export function tooWide(bounds: Bounds): boolean {
  return (bounds.north - bounds.south) > MAX_SPAN_DEGREES
}

/**
 * Is a point inside the box?
 *
 * The map keeps every pin it has loaded, so "how many are here" and "how many
 * are held" are different numbers — and a status line that says *in view*
 * while counting the second is a lie that grows with every pan.
 */
export function within(bounds: Bounds, point: { lat: number; lng: number }): boolean {
  return point.lat >= bounds.south
    && point.lat <= bounds.north
    && point.lng >= bounds.west
    && point.lng <= bounds.east
}
