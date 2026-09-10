import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadGoogleMaps, MapsUnavailableError } from '../lib/googleMaps'
import { Alert, Button, Spinner } from '../components/primitives'
import { useT } from '../i18n'
import { parsePopupConfig } from '../../api/author/popupConfig'
import { ListingPopup } from './ListingPopup'
import { meDataUri, ME_SIZE, pinDataUri, PIN_SIZE } from './pinMarker'
import type { MapPin } from './markers'
import { groupByVenue, type VenueGroup } from './venueGrouping'
import { VenueStack } from './VenueStack'
import { MapList } from './MapList'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { padBounds, sameBounds, within, type Bounds } from './viewport'
import { useViewportListings } from './useViewportListings'
import type { ResolvedLocation } from './useLocation'
import { haversineKm, boundingBox } from '../../api/lib/geo'

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
/** Close enough that "near me" means streets rather than districts. */
const PRECISE_ZOOM = 14

/**
 * Half the span of the box the list falls back to when there is no map to
 * take a viewport from (#40). Roughly a city and its outskirts — the same
 * ground `OPENING_ZOOM` would have shown.
 */
const FALLBACK_SPAN = 0.09

/**
 * The distance chips (#38), ported unchanged. 2km is walking, 5km is a short
 * ride, 10km covers the valley, 20km covers it and its edges, and 100km is
 * "worth the trip" — which for Nepal's geography is a real category rather
 * than an arbitrary round number.
 */
export const DISTANCE_CHIPS_KM = [2, 5, 10, 20, 100]

type Props = {
  /** Where a popup's "See the listing" goes. */
  onOpen: (slug: string) => void
  /**
   * The staged location (#38), resolved by the page so that the headline
   * beside the map and the map itself agree about which city this is. Absent
   * on surfaces that have no location story of their own.
   */
  location?: ResolvedLocation
}

export function NepalMap({ onOpen, location }: Props) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const overlayRef = useRef<google.maps.OverlayView | null>(null)
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map())
  const meMarkerRef = useRef<google.maps.Marker | null>(null)
  /**
   * The viewer has panned or zoomed themselves. Read by the follow effect,
   * held in a ref rather than in state because nothing renders from it and a
   * re-render on every drag is exactly what the `idle` handler avoids.
   */
  const movedRef = useRef(false)
  /** The latest centre, for the one-shot map constructor to read at build time. */
  const centreRef = useRef<{ lat: number; lng: number } | null>(null)

  const [ready, setReady] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [viewport, setViewport] = useState<Bounds | null>(null)
  /** The selected distance chip, in km, or null for "everywhere in view". */
  const [radiusKm, setRadiusKm] = useState<number | null>(null)
  /**
   * Which surface is showing (#40). The list is not a lesser mode — it is the
   * equivalent path, and it is what renders when the Maps API does not.
   */
  const [view, setView] = useState<'map' | 'list'>('map')
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

  /**
   * What the query is scoped to.
   *
   * Normally the map's own viewport. When the Maps API failed there is no map
   * to have a viewport, and the list still has to show something — so a box is
   * drawn around wherever location resolution got to. Same query, same
   * bounding, same rows: the fallback is not a different data path.
   */
  const effectiveViewport = viewport ?? (unavailable
    ? padBounds({
        south: (centreRef.current ?? OPENING_CENTRE).lat - FALLBACK_SPAN,
        north: (centreRef.current ?? OPENING_CENTRE).lat + FALLBACK_SPAN,
        west: (centreRef.current ?? OPENING_CENTRE).lng - FALLBACK_SPAN,
        east: (centreRef.current ?? OPENING_CENTRE).lng + FALLBACK_SPAN,
      }, 0)
    : null)

  const { pins: fetched, loading, error, wide } = useViewportListings(effectiveViewport)

  // Read by the map constructor, which runs once and cannot see later state.
  centreRef.current = location?.centre ?? null

  /**
   * The distance filter, applied to what is held (#38).
   *
   * Client-side, and correctly so: the rows are already in memory, the circle
   * is inside the box that fetched them, and the alternative — a `lat`/`lng`/
   * `radius_km` search — is refused by the API when a bbox is also present,
   * because a viewport and a radius are two answers to one SQL box
   * (api/catalog/shared.ts). The map owns the viewport, so the map owns the
   * circle inside it.
   */
  const pins = useMemo(() => {
    if (radiusKm === null || !location?.precise) return fetched
    const { lat, lng } = location.centre
    return fetched.filter((pin) => haversineKm(lat, lng, pin.lat, pin.lng) <= radiusKm)
  }, [fetched, radiusKm, location?.precise, location?.centre])

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
  const inView = effectiveViewport
    ? pins.filter((pin) => within(effectiveViewport, pin)).length
    : 0

  /**
   * The list shows what is *on screen*, not everything ever loaded — otherwise
   * "the list view offers the same results as the map" stops being true the
   * first time somebody pans, because the map drops pins off its edges and
   * the list would not.
   */
  const visibleGroups = useMemo(
    () => (effectiveViewport
      ? groupByVenue(pins.filter((pin) => within(effectiveViewport, pin)))
      : []),
    [pins, effectiveViewport],
  )

  // ── Build the map, once ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    loadGoogleMaps().then((maps) => {
      if (cancelled || !containerRef.current || mapRef.current) return

      const map = new maps.Map(containerRef.current, {
        // Whatever location resolution has reached by now. `useLocation`
        // starts at the default, so this is never undefined and never waits:
        // the map draws immediately and moves later if a better answer lands.
        // "Location resolution never blocks the map from rendering" is the
        // criterion, and it is satisfied by never awaiting it here.
        center: centreRef.current ?? OPENING_CENTRE,
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
        const next = {
          north: ne.lat(), east: ne.lng(), south: sw.lat(), west: sw.lng(),
        }
        // Same rectangle, same object — otherwise the fetch effect restarts,
        // aborting a request that was already on its way for this very box and
        // issuing it again. `idle` fires for more than pans.
        setViewport((current) => (sameBounds(current, next) ? current : next))
      })
      // A drag is the gesture that means "show me somewhere else"; a popup
      // anchored to a pin that is now off screen is just a floating card.
      map.addListener('dragstart', () => {
        // And it is also the gesture that means "stop moving the map for me".
        movedRef.current = true
        setSelected(null)
      })
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

  /**
   * Follow the resolved centre.
   *
   * Only while the viewer has not taken over. Panning is a statement about
   * where they want to look, and a map that yanks itself back to their own
   * city because a geo-IP response finally landed is a map that fights them.
   */
  useEffect(() => {
    if (!ready || !mapRef.current || !location) return
    if (movedRef.current) return
    // The first stage to produce a real answer wins the opening view; after
    // that only an explicit locate-me moves it, and that is handled below.
    // `default` is excluded because the map already opened there — moving it
    // to where it is costs an `idle` and buys nothing.
    if (location.stage !== 'ip') return
    mapRef.current.setCenter(location.centre)
  }, [ready, location?.stage, location?.centre])

  /**
   * A granted position is an explicit request to be shown where you are, so
   * it overrides a pan in a way an IP guess never should.
   */
  useEffect(() => {
    if (!ready || !mapRef.current || !location?.precise) return
    movedRef.current = false
    mapRef.current.setCenter(location.centre)
    mapRef.current.setZoom(PRECISE_ZOOM)
  }, [ready, location?.precise, location?.centre])

  /** Refit to the circle when a distance chip is chosen. */
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || radiusKm === null || !location?.precise) return
    const box = boundingBox(location.centre.lat, location.centre.lng, radiusKm)
    // The chip means "show me this far", so the viewport becomes the circle's
    // box — which also makes the next fetch ask for exactly that ground.
    movedRef.current = false
    map.fitBounds(new google.maps.LatLngBounds(
      new google.maps.LatLng(box.minLat, box.minLng),
      new google.maps.LatLng(box.maxLat, box.maxLng),
    ))
  }, [ready, radiusKm, location?.precise, location?.centre])

  /**
   * Focus moves into whatever opened over the map, and back to the map when it
   * closes (#40).
   *
   * Without this a keyboard user who opens a popup is still focused on the
   * control they came from, and a screen reader announces nothing — the card
   * appears silently, off to one side, for someone who cannot see it appear.
   * `useFocusTrap` also restores focus on close, which is the half that stops
   * every dismissal sending them back to the top of the page.
   */
  const popupRef = useRef<HTMLDivElement>(null)
  const closeSelected = useCallback(() => setSelected(null), [])
  useFocusTrap(popupRef, selected !== null, closeSelected)

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

  // ── "You are here", once there is a precise answer ─────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return

    if (!location?.precise) {
      meMarkerRef.current?.setMap(null)
      meMarkerRef.current = null
      return
    }

    const position = { lat: location.centre.lat, lng: location.centre.lng }
    if (meMarkerRef.current) {
      meMarkerRef.current.setPosition(position)
      return
    }
    meMarkerRef.current = new google.maps.Marker({
      map,
      position,
      title: 'You are here',
      // Deliberately not a teardrop: a listing pin points at a thing that is
      // happening, and the viewer is not one of those. A dot is the
      // convention every map uses for the reader's own position.
      icon: {
        url: meDataUri(),
        scaledSize: new google.maps.Size(ME_SIZE, ME_SIZE),
        anchor: new google.maps.Point(ME_SIZE / 2, ME_SIZE / 2),
      },
      // Under the listings: it is orientation, not content.
      zIndex: 0,
    })
  }, [ready, location?.precise, location?.centre])

  // Everything goes when the component does; the SDK holds its own references
  // and a marker left with a map is a leak that survives navigation.
  useEffect(() => () => {
    for (const marker of markersRef.current.values()) marker.setMap(null)
    markersRef.current.clear()
    meMarkerRef.current?.setMap(null)
    meMarkerRef.current = null
    overlayRef.current?.setMap(null)
  }, [])

  /**
   * The Maps API can be blocked, rate-limited, or absent from a build that has
   * no key. None of those is a reason to stop being a discovery product, so
   * the list takes over (#40) — explained, not apologised for, and with the
   * same listings on it the pins would have carried.
   */
  const showList = view === 'list' || unavailable !== null

  return (
    <div
      ref={rootRef}
      className={`nepal-map${fullscreen ? ' nepal-map--fullscreen' : ''}${showList ? ' nepal-map--list' : ''}`}
    >
      {unavailable ? (
        <Alert tone="warning" title="The map is not available">
          {unavailable} Everything that would have been on it is listed below.
        </Alert>
      ) : (
        <div ref={containerRef} className="nepal-map__canvas" role="application" aria-label="Map of listings" hidden={view === 'list'} />
      )}

      {!ready && !unavailable && view === 'map' && (
        <div className="nepal-map__veil"><Spinner /> <span>Loading the map…</span></div>
      )}

      {showList && (
        <div className="nepal-map__list">
          <MapList
            groups={visibleGroups}
            onOpen={onOpen}
            emptyLabel={radiusKm !== null
              ? `Nothing within ${radiusKm} km of you.`
              : 'Nothing listed in this area yet.'}
          />
        </div>
      )}

      <div className="nepal-map__controls">
        {/* The list is a peer of the map, not a fallback hidden behind a
            failure — somebody who finds pins hard to work with should be able
            to choose the list on a working map, and the criterion is that
            both offer the same filters and the same results. Hidden when the
            Maps API failed, because then there is nothing to switch back to. */}
        {!unavailable && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setView((current) => (current === 'map' ? 'list' : 'map'))}
            aria-pressed={view === 'list'}
          >
            {view === 'list' ? t('map.showMap') : t('map.showList')}
          </Button>
        )}
        {location && (
          <Button
            type="button"
            variant="secondary"
            onClick={location.locate}
            disabled={location.stage === 'locating'}
            aria-pressed={location.precise}
          >
            {location.stage === 'locating' ? t('map.locating')
              : location.precise ? t('map.centred')
              : t('map.nearMe')}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          onClick={() => setFullscreen((on) => !on)}
          aria-pressed={fullscreen}
        >
          {fullscreen ? 'Exit full screen' : 'Full screen'}
        </Button>
      </div>

      {/* The distance chips (#38). They appear only once there is a position
          precise enough for "within 2km" to be true rather than decorative —
          a geo-IP centroid is accurate to a district, and filtering a 2km
          circle around one would quietly hide listings that are in fact
          nearby. */}
      {location?.precise && (
        <div className="nepal-map__distances" role="group" aria-label={t('map.distanceGroup')}>
          {DISTANCE_CHIPS_KM.map((km) => (
            <button
              key={km}
              type="button"
              className="nepal-map__distance"
              // A second press on the active chip clears it, which is how
              // every chip row in the app already behaves.
              onClick={() => setRadiusKm((current) => (current === km ? null : km))}
              aria-pressed={radiusKm === km}
            >
              {t('map.km', { km: String(km) })}
            </button>
          ))}
        </div>
      )}

      {/* The permission-denied path. Not an error — the map behind it is
          working and showing a whole city. What it says is what actually
          changed: distance filtering is unavailable, and here is how to get
          it back. */}
      {location?.denied && (
        <p className="nepal-map__denied" role="status">
          {t('map.denied', { city: location.city })}
        </p>
      )}

      {/* Status, not decoration: a map that is quietly showing a subset is
          worse than one that says it is. */}
      <div className="nepal-map__status" role="status" aria-live="polite">
        {wide && <span className="nepal-map__hint">Zoom in to load listings.</span>}
        {loading && !wide && <span className="nepal-map__hint">Loading listings…</span>}
        {error && <span className="nepal-map__hint nepal-map__hint--error">{error}</span>}
        {!loading && !wide && !error && (
          <span className="nepal-map__hint">
            {inView === 0
              // A filter that hides everything must say it was the filter. An
              // empty map that blames the area is how somebody concludes there
              // is nothing on and leaves.
              ? radiusKm !== null
                ? `Nothing within ${radiusKm} km of you.`
                : 'Nothing listed in this area yet.'
              : `${inView} listing${inView === 1 ? '' : 's'}${radiusKm !== null ? ` within ${radiusKm} km` : ' in view'}`}
          </span>
        )}
      </div>

      {selected && (
        <div
          ref={popupRef}
          className="nepal-map__popup"
          style={{ left: selected.x, top: selected.y }}
          // A card that opens over the map and traps focus is a dialog, and
          // saying so is what makes a screen reader announce it on arrival
          // rather than leaving the reader to discover it.
          role="dialog"
          aria-modal="true"
          aria-label={selected.kind === 'stack'
            ? `Listings at ${selected.group.primary.popup.venue ?? 'this place'}`
            : selected.pin.popup.title}
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
