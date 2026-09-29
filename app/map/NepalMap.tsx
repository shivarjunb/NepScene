import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadGoogleMaps, MapsUnavailableError } from '../lib/googleMaps'
import { Alert, Spinner } from '../components/primitives'
import { useT } from '../i18n'
import { parsePopupConfig } from '../../api/author/popupConfig'
import { ListingPopup } from './ListingPopup'
import {
  clusterDataUri, clusterSize, meDataUri, ME_SIZE, pinDataUri, PIN_SIZE,
} from './pinMarker'
import { OVERLAP_PX, planMarkers, type Cluster } from './clustering'
import type { MapPin } from './markers'
import { groupByVenue, type VenueGroup } from './venueGrouping'
import { VenueStack } from './VenueStack'
import { MapList } from './MapList'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { PAD_RATIO, padBounds, sameBounds, within, type Bounds } from './viewport'
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
 * How long a gesture is allowed to keep settling before its viewport is
 * committed (#39). Long enough to swallow the pauses inside a flick-flick-pinch
 * sequence, short enough that a deliberate single pan does not feel laggy.
 */
const IDLE_DEBOUNCE_MS = 250

/**
 * Half the span of the box the list falls back to when there is no map to
 * take a viewport from (#40). Roughly a city and its outskirts — the same
 * ground `OPENING_ZOOM` would have shown.
 */
const FALLBACK_SPAN = 0.09

/**
 * A cluster whose contents span less than this, in degrees (about 20m), is a
 * set of places zooming cannot pull apart — two venues geocoded to the same
 * point, typically. Tapping it opens their listings as one stack instead of
 * zooming to a box that would still draw the same bubble.
 */
const INSEPARABLE_SPAN = 0.0002

/**
 * The distance chips (#38), ported unchanged. 2km is walking, 5km is a short
 * ride, 10km covers the valley, 20km covers it and its edges, and 100km is
 * "worth the trip" — which for Nepal's geography is a real category rather
 * than an arbitrary round number.
 */
export const DISTANCE_CHIPS_KM = [2, 5, 10, 20, 100]

/** What one marker on the map stands for: a place, or an area of places. */
type Drawable =
  | { kind: 'group'; group: VenueGroup }
  | { kind: 'cluster'; cluster: Cluster }

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
  /** The pending debounced viewport commit, if a gesture is still settling. */
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Whether a viewport has ever been committed. The first one is immediate. */
  const committedRef = useRef(false)

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
  /** Whether the distance fan is spread out around its button. */
  const [fanOpen, setFanOpen] = useState(false)
  const fanToggleRef = useRef<HTMLButtonElement>(null)
  /**
   * What is open over the map: one listing's popup, or a venue's stack. Never
   * both — they occupy the same place, and a stack behind a popup is a card
   * the viewer cannot reach.
   *
   * Not anchored to the pin. A card drawn above a pin was clipped by the map's
   * edge whenever the pin sat in its top half — and in the hero, which is
   * short, that was most pins. The card opens across the top of the map
   * instead, where it always fits, and the map moves the pin into the space
   * below it (`focusAt`).
   */
  const [selected, setSelected] = useState<
    | { kind: 'listing'; pin: MapPin }
    | { kind: 'stack'; group: VenueGroup; venueName: string | null }
    | null
  >(null)
  /** Where the open card came from, so the map can bring it into view. */
  const [focusAt, setFocusAt] = useState<{ lat: number; lng: number } | null>(null)

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

  /** "3 listings" — the noun the status line's every phrasing shares. */
  const countLabel = inView === 1
    ? t('map.listingCountOne')
    : t('map.listingCount', { count: inView })

  /**
   * What actually gets a marker (#39).
   *
   * Virtualised to the padded viewport, then clustered if that is still too
   * many. Padded rather than exact so a pin does not pop into existence as its
   * point crosses the screen edge, which reads as the map stuttering rather
   * than as the pin arriving.
   */
  const plan = useMemo(() => {
    if (!effectiveViewport) return planMarkers(groups, null)
    // Pins that would overlap on screen are merged too, not only a screen too
    // dense to read. `OVERLAP_PX` becomes degrees through the map's own
    // size; a hidden canvas (the list view) measures zero and merges nothing.
    const width = containerRef.current?.clientWidth ?? 0
    const height = containerRef.current?.clientHeight ?? 0
    const overlap = width > 0 && height > 0
      ? {
          lat: ((effectiveViewport.north - effectiveViewport.south) / height) * OVERLAP_PX,
          lng: ((effectiveViewport.east - effectiveViewport.west) / width) * OVERLAP_PX,
        }
      : null
    return planMarkers(groups, padBounds(effectiveViewport, PAD_RATIO / 2), { overlap })
  }, [groups, effectiveViewport])

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

        const commit = () => {
          // Same rectangle, same object — otherwise the fetch effect restarts,
          // aborting a request that was already on its way for this very box
          // and issuing it again. `idle` fires for more than pans.
          setViewport((current) => (sameBounds(current, next) ? current : next))
        }

        // The first view is not debounced: nothing is on screen yet, and
        // making the map wait a quarter-second before its first request would
        // be paying the debounce's cost with none of its benefit.
        if (!committedRef.current) {
          committedRef.current = true
          commit()
          return
        }

        // **The gesture debounce (#39).** `idle` is the SDK's own debounce and
        // handles a single drag, but a *sequence* — three flicks, a pinch, a
        // double-tap zoom — settles several times in under a second, each
        // settling on a different box that `needsFetch` would honestly say
        // needs fetching. Coalescing them means a gesture costs one request
        // rather than one per pause within it.
        if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
        idleTimerRef.current = setTimeout(() => {
          idleTimerRef.current = null
          commit()
        }, IDLE_DEBOUNCE_MS)
      })
      // A drag is the gesture that means "show me somewhere else"; a popup
      // anchored to a pin that is now off screen is just a floating card.
      map.addListener('dragstart', () => {
        // And it is also the gesture that means "stop moving the map for me".
        movedRef.current = true
        setSelected(null)
        setFanOpen(false)
      })
      map.addListener('click', () => {
        setSelected(null)
        setFanOpen(false)
      })

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
    if (!fullscreen && !selected && !fanOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Innermost first: Escape closes the popup or the fan, and only then
      // the fullscreen.
      if (selected) setSelected(null)
      else if (fanOpen) {
        setFanOpen(false)
        fanToggleRef.current?.focus()
      } else setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, selected, fanOpen])

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

  /**
   * Bring the tapped place into the space the card leaves open.
   *
   * On a phone the card sits across the top of the map, and on a wider screen
   * down its right-hand side — either way over part of the map, so a pin there
   * would be underneath the card about it. Centre on the place, then shift it
   * to the middle of what the card leaves, measured after the card has drawn.
   */
  const isOpen = selected !== null
  useEffect(() => {
    const map = mapRef.current
    if (!isOpen || !focusAt || !map || view !== 'map') return
    const frame = requestAnimationFrame(() => {
      const box = containerRef.current?.getBoundingClientRect()
      const card = popupRef.current?.getBoundingClientRect()
      if (!box || !card || box.height === 0) return
      // The pin is drawn above its point, so its point goes half a pin lower
      // than the middle of the space.
      const beside = card.width < box.width * 0.6
      const x = beside ? (card.left - box.left) / 2 : box.width / 2
      const top = beside ? 0 : card.bottom - box.top
      const y = top + (box.height - top) / 2 + PIN_SIZE / 2
      // A move the viewer asked for, by tapping: the follow effect must not
      // pull the map back to their city afterwards.
      movedRef.current = true
      map.panTo(focusAt)
      map.panBy(box.width / 2 - x, box.height / 2 - y)
    })
    return () => cancelAnimationFrame(frame)
  }, [focusAt, isOpen, view])

  // ── Draw the pins ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const live = markersRef.current
    // Keyed on the group *and* its count: a venue that gains a listing while
    // the map is open has to redraw, because its bubble now says a different
    // number. Keying on the venue alone would leave a stale count on screen.
    // Clusters are keyed the same way, on cell and count.
    const wanted = new Map<string, Drawable>([
      ...plan.groups.map((group) => [`g:${group.key}:${group.count}`, { kind: 'group', group }] as const),
      ...plan.clusters.map((cluster) => [`c:${cluster.key}:${cluster.count}`, { kind: 'cluster', cluster }] as const),
    ])

    // Only what left the set is torn down. Rebuilding every marker on every
    // pan is what makes a map flicker, and it closes the popup mid-read.
    for (const [id, marker] of live) {
      if (!wanted.has(id)) {
        marker.setMap(null)
        live.delete(id)
      }
    }

    for (const [id, drawable] of wanted) {
      if (live.has(id)) continue

      if (drawable.kind === 'cluster') {
        const { cluster } = drawable
        const size = clusterSize(cluster.count)
        const marker = new google.maps.Marker({
          map,
          position: { lat: cluster.lat, lng: cluster.lng },
          title: `${cluster.count} listings in this area`,
          icon: {
            url: clusterDataUri(cluster.count),
            scaledSize: new google.maps.Size(size, size),
            // A bubble describes an area, so its centre is its position —
            // unlike a teardrop, whose point is.
            anchor: new google.maps.Point(size / 2, size / 2),
          },
          zIndex: cluster.count,
        })
        // Zoom to what it contains rather than by a fixed step: one press
        // opens the cluster, however deep it was.
        marker.addListener('click', () => {
          const { bounds } = cluster
          if (bounds.north - bounds.south < INSEPARABLE_SPAN
            && bounds.east - bounds.west < INSEPARABLE_SPAN) {
            const pins = cluster.groups.flatMap((group) => group.pins)
            setFanOpen(false)
            setFocusAt({ lat: cluster.lat, lng: cluster.lng })
            setSelected({
              kind: 'stack',
              group: { ...cluster.groups[0]!, key: cluster.key, pins, count: pins.length },
              venueName: null,
            })
            return
          }
          movedRef.current = true
          setSelected(null)
          map.fitBounds(new google.maps.LatLngBounds(
            new google.maps.LatLng(cluster.bounds.south, cluster.bounds.west),
            new google.maps.LatLng(cluster.bounds.north, cluster.bounds.east),
          ))
        })
        live.set(id, marker)
        continue
      }

      const { group } = drawable
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
        // One listing opens its card directly. Making a single listing go
        // through a list of one would be a step that never told anybody
        // anything.
        setFanOpen(false)
        setFocusAt({ lat: group.lat, lng: group.lng })
        setSelected(group.count === 1
          ? { kind: 'listing', pin: group.primary }
          : { kind: 'stack', group, venueName: group.primary.popup.venue })
      })
      live.set(id, marker)
    }
  }, [plan, ready])

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
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
    for (const marker of markersRef.current.values()) marker.setMap(null)
    markersRef.current.clear()
    meMarkerRef.current?.setMap(null)
    meMarkerRef.current = null
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
            heading={t('map.listHeading')}
            emptyLabel={radiusKm !== null
              ? `Nothing within ${radiusKm} km of you.`
              : 'Nothing listed in this area yet.'}
          />
        </div>
      )}

      {/* The map's own tools, stacked in the bottom-left corner as icons. They
          used to be labelled pills in the top-right, and on a phone they
          wrapped into a second row and met the distance chips coming the other
          way, until the top third of the map could not be touched. Each keeps
          its words as its accessible name and its tooltip. */}
      <div className="nepal-map__tools">
        {/* The list is a peer of the map, not a fallback hidden behind a
            failure — somebody who finds pins hard to work with should be able
            to choose the list on a working map, and the criterion is that
            both offer the same filters and the same results. Hidden when the
            Maps API failed, because then there is nothing to switch back to. */}
        {!unavailable && (
          <ToolButton
            label={view === 'list' ? t('map.showMap') : t('map.showList')}
            onClick={() => setView((current) => (current === 'map' ? 'list' : 'map'))}
            pressed={view === 'list'}
            icon={view === 'list' ? 'map' : 'list'}
          />
        )}
        {location && (
          <ToolButton
            label={location.stage === 'locating' ? t('map.locating')
              : location.precise ? t('map.centred')
              : t('map.nearMe')}
            onClick={location.locate}
            disabled={location.stage === 'locating'}
            pressed={location.precise}
            icon="locate"
          />
        )}
        <ToolButton
          label={fullscreen ? 'Exit full screen' : 'Full screen'}
          onClick={() => setFullscreen((on) => !on)}
          pressed={fullscreen}
          icon={fullscreen ? 'shrink' : 'expand'}
        />
      </div>

      {/* The distance filter (#38): one button in the bottom-right corner that
          fans the five distances out in a quarter circle around itself, and
          folds them away again once one is chosen. It appears only once there
          is a position precise enough for "within 2km" to be true rather than
          decorative — a geo-IP centroid is accurate to a district, and
          filtering a 2km circle around one would quietly hide listings that
          are in fact nearby. */}
      {location?.precise && (
        <div className="nepal-map__distances" role="group" aria-label={t('map.distanceGroup')}>
          <button
            type="button"
            ref={fanToggleRef}
            className="nepal-map__fan-toggle"
            onClick={() => {
              // One thing open over the map at a time: the fan and a popup
              // want the same corner of the reader's attention.
              setSelected(null)
              setFanOpen((open) => !open)
            }}
            aria-expanded={fanOpen}
            aria-label={`${t('map.distanceToggle')}, ${radiusKm === null
              ? t('map.anyDistance')
              : t('map.km', { km: String(radiusKm) })}`}
          >
            {fanOpen ? <Icon name="close" /> : (
              <>
                <Icon name="radius" size={18} />
                <span className="nepal-map__fan-label" aria-hidden="true">
                  {radiusKm === null ? t('map.anyDistance') : t('map.km', { km: String(radiusKm) })}
                </span>
              </>
            )}
          </button>
          {/* After the toggle, so Tab goes from it into the distances. */}
          {fanOpen && DISTANCE_CHIPS_KM.map((km, index) => (
            <button
              key={km}
              type="button"
              className="nepal-map__distance"
              // The chip's place on the arc. A position, not a colour, so it
              // is set here rather than given a token.
              style={{ '--fan-angle': `${180 + index * (90 / (DISTANCE_CHIPS_KM.length - 1))}deg` } as React.CSSProperties}
              // A second press on the active chip clears it, which is how
              // every chip row in the app already behaves.
              onClick={() => {
                setRadiusKm((current) => (current === km ? null : km))
                setFanOpen(false)
                // The chip is about to go; focus goes back to what opened it
                // rather than falling to the top of the page.
                fanToggleRef.current?.focus()
              }}
              aria-pressed={radiusKm === km}
              aria-label={t('map.km', { km: String(km) })}
            >
              <span className="nepal-map__distance-value">{km}</span>
              <span className="nepal-map__distance-unit">{t('map.km', { km: '' }).trim()}</span>
            </button>
          ))}
        </div>
      )}

      {/* The top-left corner says what the map is showing, and — when the
          viewer said no to their location — what that changed. */}
      <div className="nepal-map__top">
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
          {wide && <span className="nepal-map__hint">{t('map.zoomIn')}</span>}
          {loading && !wide && (
            <span className="nepal-map__hint">
              {/* Progressive rendering (#39) means the map is usable before the
                  last page lands, and a status saying only "loading" would hide
                  that. Once anything is drawn, the count leads. */}
              {inView > 0 ? t('map.loadingSoFar', { count: countLabel }) : t('map.loading')}
            </span>
          )}
          {error && <span className="nepal-map__hint nepal-map__hint--error">{error}</span>}
          {!loading && !wide && !error && (
            <span className="nepal-map__hint">
              {inView === 0
                // A filter that hides everything must say it was the filter. An
                // empty map that blames the area is how somebody concludes there
                // is nothing on and leaves.
                ? radiusKm !== null
                  ? t('map.nothingWithin', { km: radiusKm })
                  : t('map.nothingHere')
                // A clustered view is showing areas, not places, and a viewer
                // who does not know that reads the bubbles as venues.
                : plan.kind === 'clusters'
                  ? t('map.clustered', { count: countLabel })
                  : radiusKm !== null
                    ? t('map.within', { count: countLabel, km: radiusKm })
                    : t('map.inView', { count: countLabel })}
            </span>
          )}
        </div>
      </div>

      {selected && (
        // Gives a tap outside the card somewhere to land that means "close",
        // rather than whatever control was underneath it.
        <div className="nepal-map__scrim" aria-hidden="true" onClick={closeSelected} />
      )}

      {selected && (
        <div
          ref={popupRef}
          className="nepal-map__popup"
          // A card that opens over the map and traps focus is a dialog, and
          // saying so is what makes a screen reader announce it on arrival
          // rather than leaving the reader to discover it.
          role="dialog"
          aria-modal="true"
          aria-label={selected.kind === 'stack'
            ? `Listings at ${selected.venueName ?? 'this place'}`
            : selected.pin.popup.title}
        >
          {selected.kind === 'stack' ? (
            <VenueStack
              group={selected.group}
              venueName={selected.venueName}
              onSelect={(pin) => setSelected({ kind: 'listing', pin })}
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

type IconName = 'list' | 'map' | 'locate' | 'expand' | 'shrink' | 'radius' | 'close'

/** Stroke paths on a 24px grid, drawn in the text colour of the control. */
const ICON_PATHS: Record<IconName, string> = {
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  locate: 'M12 2v3M12 19v3M2 12h3M19 12h3M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  radius: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  close: 'M6 6l12 12M18 6 6 18',
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

/**
 * A round icon control on the map. The words it would have shown are its
 * accessible name and its tooltip, so nothing a label said is lost to a
 * screen reader or to a pointer that hovers.
 */
function ToolButton({ label, icon, onClick, pressed, disabled }: {
  label: string
  icon: IconName
  onClick: () => void
  pressed?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="nepal-map__tool"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
    >
      <Icon name={icon} />
    </button>
  )
}
