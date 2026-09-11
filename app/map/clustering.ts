import type { VenueGroup } from './venueGrouping'
import type { Bounds } from './viewport'

/**
 * Keeping the marker count bounded, whatever the catalogue does (#39).
 *
 * Two rules, in order, and they solve different halves of the same problem.
 *
 * **Virtualisation** answers "how many markers exist". Pins are kept across
 * pans so a drag does not rebuild the map, which means the held set is much
 * larger than the screen — and drawing a marker for every held pin means the
 * marker count grows with how long somebody has been panning rather than with
 * what they can see. Only what is in view gets a marker.
 *
 * **Clustering** answers "how many markers can be in view at once". At the
 * valley's density, ten thousand listings across a hundred venues is a
 * hundred markers on one screen — legible. Ten thousand across ten thousand
 * points is not, and it is also where the Maps SDK's own cost stops being
 * linear. Above a threshold the visible groups are collapsed onto a grid whose
 * cell size comes from the zoom, so the marker count has a ceiling that does
 * not depend on the catalogue at all.
 *
 * Neither is a rendering trick: both are decisions about what is *meaningful*
 * to show. A screen with four thousand overlapping teardrops on it does not
 * contain more information than one with sixty.
 */

/**
 * Above this many groups in view, the screen stops being a map of places and
 * starts being a texture. Chosen from the marker size: at 40px a pin, sixty
 * pins is already most of a phone screen.
 */
export const CLUSTER_THRESHOLD = 60

/**
 * Grid cells across the viewport's width when clustering. The cluster count is
 * bounded by `CELLS × CELLS` — 144 — but in practice lands far below it,
 * because listings are not uniformly distributed and empty cells draw nothing.
 */
const CELLS = 12

export type Cluster = {
  /** Cell coordinates, stable for a given viewport and zoom. */
  key: string
  lat: number
  lng: number
  /** Listings, not venues: a bubble saying 9 must mean nine things to go to. */
  count: number
  /** The venues inside, so a click can zoom to exactly what it contains. */
  groups: VenueGroup[]
  bounds: Bounds
}

/** What the map should draw right now: either groups, or clusters of them. */
export type MarkerPlan =
  | { kind: 'groups'; groups: VenueGroup[]; clusters: [] }
  | { kind: 'clusters'; groups: []; clusters: Cluster[] }

/**
 * Cut the held groups down to what is on screen, then cluster if that is still
 * too many.
 *
 * The viewport passed in should be the *padded* one. Clipping to the exact
 * screen edge makes a pin pop into existence as its point crosses the boundary,
 * which reads as the map stuttering rather than as the pin arriving.
 */
export function planMarkers(
  groups: VenueGroup[],
  viewport: Bounds | null,
  threshold = CLUSTER_THRESHOLD,
): MarkerPlan {
  if (!viewport) return { kind: 'groups', groups: [], clusters: [] }

  const visible = groups.filter((group) => inside(viewport, group))
  if (visible.length <= threshold) return { kind: 'groups', groups: visible, clusters: [] }
  return { kind: 'clusters', groups: [], clusters: clusterGroups(visible, viewport) }
}

const inside = (bounds: Bounds, at: { lat: number; lng: number }) =>
  at.lat >= bounds.south && at.lat <= bounds.north
  && at.lng >= bounds.west && at.lng <= bounds.east

/**
 * Grid clustering, with the cell size derived from the viewport rather than
 * from a fixed distance.
 *
 * That is what makes it zoom-dependent without reading the zoom: a viewport
 * spanning a country has country-sized cells and one spanning a street has
 * street-sized cells, and the number of clusters on screen stays roughly
 * constant through a pinch. Reading `map.getZoom()` and switching on integer
 * levels — the usual approach — produces a visible jump at each level and
 * behaves differently on a phone and a desktop, which have very different
 * spans at the same zoom.
 *
 * The cluster is drawn at the *centroid of what it contains*, not at the
 * centre of its cell. A bubble sitting in a lake because that is where the
 * grid line fell is worse than no bubble.
 */
function clusterGroups(groups: VenueGroup[], viewport: Bounds): Cluster[] {
  const latStep = (viewport.north - viewport.south) / CELLS
  const lngStep = (viewport.east - viewport.west) / CELLS
  // A degenerate viewport — zero span — would divide by zero and put every
  // group in one cell with a NaN key.
  if (latStep <= 0 || lngStep <= 0) {
    return [asCluster('all', groups)]
  }

  const cells = new Map<string, VenueGroup[]>()
  for (const group of groups) {
    const row = Math.floor((group.lat - viewport.south) / latStep)
    const column = Math.floor((group.lng - viewport.west) / lngStep)
    const key = `${row}:${column}`
    const held = cells.get(key)
    if (held) held.push(group)
    else cells.set(key, [group])
  }

  return [...cells].map(([key, held]) => asCluster(key, held))
}

function asCluster(key: string, groups: VenueGroup[]): Cluster {
  let lat = 0
  let lng = 0
  let count = 0
  let south = Infinity
  let north = -Infinity
  let west = Infinity
  let east = -Infinity

  for (const group of groups) {
    lat += group.lat
    lng += group.lng
    count += group.count
    south = Math.min(south, group.lat)
    north = Math.max(north, group.lat)
    west = Math.min(west, group.lng)
    east = Math.max(east, group.lng)
  }

  return {
    key,
    lat: lat / groups.length,
    lng: lng / groups.length,
    count,
    groups,
    bounds: { south, north, west, east },
  }
}
