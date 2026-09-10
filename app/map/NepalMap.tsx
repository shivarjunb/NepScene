import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadGoogleMaps, MapsUnavailableError } from '../lib/googleMaps'
import { Alert, Button, Spinner } from '../components/primitives'
import { parsePopupConfig } from '../../api/author/popupConfig'
import { ListingPopup } from './ListingPopup'
import { pinDataUri, PIN_SIZE } from './pinMarker'
import type { MapPin } from './markers'
import { groupByVenue, type VenueGroup } from './venueGrouping'
import { VenueStack } from './VenueStack'
import { within, type Bounds } from './viewport'
import { useViewportListings } from './useViewportListings'

/**
 * The public map (#36).
 *
 * Ported from WaahTickets' `NepalMap`, which was 488 lines holding four jobs:
 * the map, venue grouping, a distance ring and the commerce card. Two of those
 * are somebody else's feature here — distance is #38 and the commerce never
 * comes across at all (docs/SCOPE.md) — and grouping (#37) lives in
 * `venueGrouping.ts`, which has rules in it and therefore tests, rather than
 * inside the component's lifecycle. What is left here is the map.
 *
 * Two things changed on the way in that are worth naming.
 *
 * **The data source.** The original took `events: MapEvent[]` — every
 * published event, fetched once, held in memory. That is the unbounded pattern
 * the Catalog API exists to replace, and it is the reason the map got slower
 * every month whether or not anybody panned it. Here the map asks for what is
 * in view and nothing else (`useViewportListings`).
 *
 * **The pin.** The original built an HTML string with `map-leaflet-pin` and
 * `pin-ripple` class names in it, then never used it — the map had already
 * moved to Google and drew a plain `SymbolPath.CIRCLE` instead, so the pin the
 * author previewed was not the pin the map drew. `pinMarker.ts` draws one pin
 * and both surfaces use it.
 */

/** Kathmandu, and enough of the valley to have something on screen. */
const OPENING_CENTRE = { lat: 27.7172, lng: 85.324 }
const OPENING_ZOOM = 12

type Props = {
  /** Where a popup's "See the listing" goes. */
  onOpen: (slug: string) => void
}

export function NepalMap({ onOpen }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const overlayRef = useRef<google.maps.OverlayView | null>(null)
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map())

  const [ready, setReady] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [viewport, setViewport] = useState<Bounds | null>(null)
  /**
   * What is open over the map: one listing's popup, or a venue's stack. Never
   * both — they occupy the same anchor, and a stack behind a popup is a
   * card the viewer cannot reach.
   */
  const [selected, setSelected] = useState<
    | { kind: 'listing'; pin: MapPin; x: number; y: number }
    | { kind: 'stack'; group: VenueGroup; x: number; y: number }
    | null
  >(null)

  const { pins, loading, error, wide } = useViewportListings(viewport)

  /**
   * One marker per *place*, not per listing (#37). Six listings at one venue
   * used to be six pins stacked exactly on top of each other, of which five
   * were unclickable and none of them said so.
   */
  const groups = useMemo(() => groupByVenue(pins), [pins])

  /**
   * Pins are kept across pans, so what is held and what is on screen are two
   * different numbers. The status line means the second one.
   */
  const inView = viewport ? pins.filter((pin) => within(viewport, pin)).length : 0

  // ── Build the map, once ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    loadGoogleMaps().then((maps) => {
      if (cancelled || !containerRef.current || mapRef.current) return

      const map = new maps.Map(containerRef.current, {
        center: OPENING_CENTRE,
        zoom: OPENING_ZOOM,
        mapTypeControl: false,
        streetViewControl: false,
        // Ours is a CSS class, not the native API. The native one puts the map
        // in the browser's fullscreen layer, where a portalled modal — the
        // listing sheet, an auth prompt — renders *behind* it and looks like
        // the app hung. The class keeps everything in one stacking context.
        fullscreenControl: false,
        // Google's own POI pins swallow the click meant for the map.
        clickableIcons: false,
        /**
         * The scroll trap. `cooperative` means a one-finger drag scrolls the
         * page and a wheel scroll needs Ctrl — so a full-width map in the
         * middle of a phone screen cannot capture the gesture that was meant
         * to scroll past it. This is the behaviour WaahTickets built by hand
         * and then set `gestureHandling: 'auto'`, disabling it.
         */
        gestureHandling: 'cooperative',
      })
      mapRef.current = map

      // A projection, so a pin's popup can be positioned over it. An empty
      // OverlayView is the documented way to get one; nothing is drawn.
      const overlay = new maps.OverlayView()
      overlay.onAdd = () => {}
      overlay.draw = () => {}
      overlay.onRemove = () => {}
      overlay.setMap(map)
      overlayRef.current = overlay

      // `idle` rather than `bounds_changed`: the latter fires continuously
      // through a drag, and every frame of a pan would be a fetch decision.
      map.addListener('idle', () => {
        const bounds = map.getBounds()
        if (!bounds) return
        const ne = bounds.getNorthEast()
        const sw = bounds.getSouthWest()
        setViewport({
          north: ne.lat(), east: ne.lng(), south: sw.lat(), west: sw.lng(),
        })
      })
      // A drag is the gesture that means "show me somewhere else"; a popup
      // anchored to a pin that is now off screen is just a floating card.
      map.addListener('dragstart', () => setSelected(null))
      map.addListener('click', () => setSelected(null))

      setReady(true)
      setUnavailable(null)
    }).catch((cause: unknown) => {
      if (cancelled) return
      setUnavailable(cause instanceof MapsUnavailableError && cause.reason === 'no_key'
        ? 'This build has no map key, so the map cannot be drawn.'
        : 'The map could not be loaded.')
    })

    return () => { cancelled = true }
  }, [])

  // ── Fullscreen is a class on the body, and Escape leaves it ────────────────
  useEffect(() => {
    document.body.classList.toggle('map-is-fullscreen', fullscreen)
    // The container changed size underneath the SDK, which only re-reads it on
    // a resize event.
    const timer = setTimeout(() => {
      if (mapRef.current) google.maps.event.trigger(mapRef.current, 'resize')
    }, 80)
    return () => {
      clearTimeout(timer)
      document.body.classList.remove('map-is-fullscreen')
    }
  }, [fullscreen])

  useEffect(() => {
    if (!fullscreen && !selected) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Innermost first: Escape closes the popup, and only then the fullscreen.
      if (selected) setSelected(null)
      else setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, selected])

  /** Where a point sits in container pixels, or null if it is not on screen. */
  const positionOf = useCallback((at: { lat: number; lng: number }) => {
    const projection = overlayRef.current?.getProjection()
    if (!projection) return null
    const point = projection.fromLatLngToContainerPixel(
      new google.maps.LatLng(at.lat, at.lng),
    )
    return point ? { x: point.x, y: point.y } : null
  }, [])

  // ── Draw the pins ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const live = markersRef.current
    // Keyed on the group *and* its count: a venue that gains a listing while
    // the map is open has to redraw, because its bubble now says a different
    // number. Keying on the venue alone would leave a stale count on screen.
    const wanted = new Map(groups.map((group) => [`${group.key}:${group.count}`, group]))

    // Only what left the set is torn down. Rebuilding every marker on every
    // pan is what makes a map flicker, and it closes the popup mid-read.
    for (const [id, marker] of live) {
      if (!wanted.has(id)) {
        marker.setMap(null)
        live.delete(id)
      }
    }

    for (const [id, group] of wanted) {
      if (live.has(id)) continue
      const marker = new google.maps.Marker({
        map,
        position: { lat: group.lat, lng: group.lng },
        // What a screen reader and a hover tooltip get. A grouped pin says
        // how many, because "Jazz at the House" would be a lie about the
        // other five.
        title: group.count > 1
          ? `${group.primary.popup.venue ?? group.primary.popup.title} — ${group.count} listings`
          : group.primary.popup.title,
        icon: {
          url: pinDataUri(group.primary.pin, group.count),
          scaledSize: new google.maps.Size(PIN_SIZE, PIN_SIZE),
          // The teardrop's point is the bottom-centre of the box, and that is
          // the part that means "here".
          anchor: new google.maps.Point(PIN_SIZE / 2, PIN_SIZE),
        },
        // A busier place draws in front of a quieter one where they overlap,
        // so the pin carrying six listings is not hidden behind one carrying
        // one.
        zIndex: group.count,
      })
      marker.addListener('click', () => {
        const at = positionOf(group)
        if (!at) return
        // One listing opens its card directly. Making a single listing go
        // through a list of one would be a step that never told anybody
        // anything.
        setSelected(group.count === 1
          ? { kind: 'listing', pin: group.primary, ...at }
          : { kind: 'stack', group, ...at })
      })
      live.set(id, marker)
    }
  }, [groups, ready, positionOf])

  // Everything goes when the component does; the SDK holds its own references
  // and a marker left with a map is a leak that survives navigation.
  useEffect(() => () => {
    for (const marker of markersRef.current.values()) marker.setMap(null)
    markersRef.current.clear()
    overlayRef.current?.setMap(null)
  }, [])

  if (unavailable) {
    return (
      <Alert tone="warning" title="The map is not available">
        {unavailable} Everything on it is also in <a href="/">the listings feed</a>.
      </Alert>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`nepal-map${fullscreen ? ' nepal-map--fullscreen' : ''}`}
    >
      <div ref={containerRef} className="nepal-map__canvas" role="application" aria-label="Map of listings" />

      {!ready && (
        <div className="nepal-map__veil"><Spinner /> <span>Loading the map…</span></div>
      )}

      <div className="nepal-map__controls">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setFullscreen((on) => !on)}
          aria-pressed={fullscreen}
        >
          {fullscreen ? 'Exit full screen' : 'Full screen'}
        </Button>
      </div>

      {/* Status, not decoration: a map that is quietly showing a subset is
          worse than one that says it is. */}
      <div className="nepal-map__status" role="status" aria-live="polite">
        {wide && <span className="nepal-map__hint">Zoom in to load listings.</span>}
        {loading && !wide && <span className="nepal-map__hint">Loading listings…</span>}
        {error && <span className="nepal-map__hint nepal-map__hint--error">{error}</span>}
        {!loading && !wide && !error && (
          <span className="nepal-map__hint">
            {inView === 0
              ? 'Nothing listed in this area yet.'
              : `${inView} listing${inView === 1 ? '' : 's'} in view`}
          </span>
        )}
      </div>

      {selected && (
        <div
          className="nepal-map__popup"
          style={{ left: selected.x, top: selected.y }}
        >
          {selected.kind === 'stack' ? (
            <VenueStack
              group={selected.group}
              venueName={selected.group.primary.popup.venue}
              onSelect={(pin) => setSelected({ kind: 'listing', pin, x: selected.x, y: selected.y })}
              onClose={() => setSelected(null)}
            />
          ) : (
            <>
              {/* The author's configuration, not the default — `parsePopupConfig`
                  falls back to the default for a null, so the customisation the
                  wizard previewed (#32) is what the public map draws. */}
              <ListingPopup
                listing={selected.pin.popup}
                config={parsePopupConfig(selected.pin.popupConfig)}
                onOpen={onOpen}
              />
              <button
                type="button"
                className="nepal-map__popup-close"
                onClick={() => setSelected(null)}
                aria-label="Close"
              >
                ×
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
