import { useEffect, useRef, type RefObject } from 'react'
import { useTheme } from '../theme'
import { markerFor, type Cluster, type MarkerPlan } from './clustering'
import type { VenueGroup } from './venueGrouping'
import {
  SELECTED_PIN_ANCHOR, SELECTED_PIN_SIZE, selectedClusterDataUri, selectedClusterSize,
  selectedPinDataUri, type PinTheme,
} from './pinMarker'

/**
 * Picking out the marker whose card is open.
 *
 * The card opens across the top of the map rather than above its pin
 * (NepalMap's `selected`), which is what stopped it being clipped and what
 * lost the line from the card to the place it is about. On a busy map the
 * viewer was left to work out which of a dozen pins they had tapped. So that
 * marker is drawn larger, ringed in the accent and above its neighbours
 * (pinMarker.ts says why all three), until the card closes.
 */

/**
 * The ids NepalMap keeps its markers under. Keyed on the count as well as the
 * place, so a venue that gains a listing is redrawn with its new number — see
 * the marker effect. Here so the effect and this hook cannot disagree.
 */
export const groupMarkerId = (group: VenueGroup) => `g:${group.key}:${group.count}`
export const clusterMarkerId = (cluster: Cluster) => `c:${cluster.key}:${cluster.count}`

/** A marker as the marker effect drew it, so it can be put back exactly. */
type Resting = {
  marker: google.maps.Marker
  icon: ReturnType<google.maps.Marker['getIcon']>
  zIndex: ReturnType<google.maps.Marker['getZIndex']>
}

/**
 * @param place the venue group key of the marker that opened the card, or
 *   null while no card is open.
 *
 * Call it after the effect that draws the markers: effects run in the order
 * they are declared, and this one has to see the markers that render made.
 */
export function useSelectedMarker(
  markers: RefObject<Map<string, google.maps.Marker>>,
  plan: MarkerPlan,
  place: string | null,
): void {
  // The accent differs by theme, so a theme switch with a card open redraws
  // the ring rather than leaving the other theme's on the map.
  const { resolved: theme } = useTheme()
  const picked = useRef<Resting | null>(null)

  useEffect(() => {
    // Whichever marker draws the place *now*. Usually the one that was tapped,
    // but markers are torn down and recreated under the open card — a pan
    // fetches a venue's new listing and its pin is redrawn with the new count
    // — and the new one is picked out in its turn. Which is also why it is
    // found by place and not held by reference.
    const drawn = place === null ? null : markerFor(plan, place)
    const id = drawn === null ? null
      : drawn.kind === 'group' ? groupMarkerId(drawn.group) : clusterMarkerId(drawn.cluster)
    const marker = id === null ? null : markers.current.get(id) ?? null

    // One at a time: whatever was picked out before goes back first. A marker
    // already torn down is given its icon back too, which is harmless off the
    // map and saves asking whether it still is.
    const held = picked.current
    if (held && held.marker !== marker) {
      held.marker.setIcon(held.icon)
      held.marker.setZIndex(held.zIndex)
      picked.current = null
    }
    if (drawn === null || marker === null) return

    // Read once, before the first change, so a redraw for a new theme does not
    // record the picked-out icon as the one to go back to.
    picked.current ??= { marker, icon: marker.getIcon(), zIndex: marker.getZIndex() }
    marker.setIcon(selectedIcon(drawn, theme))
    // Above every other marker, whatever its count. MAX_ZINDEX is the highest
    // the SDK assigns by itself, and going past it is how the SDK documents
    // bringing a marker to the front.
    marker.setZIndex(google.maps.Marker.MAX_ZINDEX + 1)
  }, [markers, plan, place, theme])
}

function selectedIcon(drawn: NonNullable<ReturnType<typeof markerFor>>, theme: PinTheme): google.maps.Icon {
  if (drawn.kind === 'cluster') {
    const { count } = drawn.cluster
    const size = selectedClusterSize(count)
    return {
      url: selectedClusterDataUri(count, theme),
      scaledSize: new google.maps.Size(size, size),
      // Still an area, so still anchored at its centre.
      anchor: new google.maps.Point(size / 2, size / 2),
    }
  }
  const { group } = drawn
  return {
    url: selectedPinDataUri(group.primary.pin, group.count, theme),
    scaledSize: new google.maps.Size(SELECTED_PIN_SIZE, SELECTED_PIN_SIZE),
    // The resting pin's point, found again in the larger box, so the pin
    // grows around the place it points at instead of sliding off it.
    anchor: new google.maps.Point(SELECTED_PIN_ANCHOR.x, SELECTED_PIN_ANCHOR.y),
  }
}
