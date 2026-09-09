import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Field, Input, Spinner } from '../components/primitives'
import { loadGoogleMaps, MapsUnavailableError } from '../lib/googleMaps'
import {
  applyPlaceToVenue, coordinateWarning, formatCoordinates, roundCoordinate,
  type PlaceLike,
} from './geocode'
import type { VenueInput } from '../../api/author/validate'

/**
 * Placing a pin (#31) — ported from WaahTickets' `MapLocationPicker`, which was
 * already on Google Maps, with three things changed on the way in.
 *
 * **It degrades instead of failing.** The original showed "Map failed to load"
 * and nothing else, which on a build with no key left an author with no way to
 * set a location at all. Preview deployments and the Playwright server have no
 * key by design, so the coordinate inputs are always present and the map is an
 * enhancement above them. That also makes the "set by address entry" criterion
 * reachable without a network.
 *
 * **Reverse geocoding is new.** The original placed a pin and stopped, so an
 * author who dropped a pin still typed the address by hand underneath it.
 *
 * **The effect no longer depends on `lat`/`lng`.** In the original those were
 * in the dependency array of the effect that constructs the map, so every drag
 * tore the map down and rebuilt it — which is why dragging felt like it reset.
 * The map is built once and the marker is moved by a separate effect.
 */

type Props = {
  lat: number | null
  lng: number | null
  /** The pin moved: by click, by drag, or by choosing a search result. */
  onMove: (lat: number, lng: number) => void
  /**
   * Present when the pin is placing a venue rather than a one-off location.
   * Given it, the picker reverse-geocodes and fills the address fields in; the
   * listing's own coordinate override has no address to fill.
   */
  onGeocoded?: (venue: VenueInput) => void
  venue?: VenueInput
  /** Labels the fieldset, so two pickers on one page are distinguishable. */
  label?: string
}

/** Where the map opens when there is no pin yet. */
const KATHMANDU = { lat: 27.7172, lng: 85.324 }
const PLACED_ZOOM = 16

export function MapLocationPicker({ lat, lng, onMove, onGeocoded, venue, label = 'Location' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markerRef = useRef<google.maps.Marker | null>(null)
  const geocoderRef = useRef<google.maps.Geocoder | null>(null)
  const autocompleteRef = useRef<google.maps.places.AutocompleteService | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [ready, setReady] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<google.maps.places.AutocompletePrediction[]>([])
  const [highlighted, setHighlighted] = useState(-1)
  const [searching, setSearching] = useState(false)
  const [geocoding, setGeocoding] = useState(false)
  const [attempt, setAttempt] = useState(0)

  /**
   * The move handler, held in a ref rather than closed over.
   *
   * The map's listeners are attached once, when the map is built. A handler
   * captured there would keep whichever `onMove` was current at that moment, so
   * a click three edits later would write into a stale wizard state. The ref is
   * always the live one.
   */
  const onMoveRef = useRef(onMove)
  useEffect(() => { onMoveRef.current = onMove }, [onMove])

  /**
   * Where the map opens, read once. The construction effect must not depend on
   * the live coordinates — that was WaahTickets' bug, where every drag put new
   * values in the dependency array and tore the map down mid-gesture — so the
   * opening centre is taken through a ref instead of through a closure.
   */
  const openingCentre = useRef({ lat, lng })

  const warning = coordinateWarning(lat, lng)

  // ── Build the map, once ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    loadGoogleMaps().then((maps) => {
      if (cancelled || !containerRef.current || mapRef.current) return
      const opening = openingCentre.current
      const map = new maps.Map(containerRef.current, {
        center: opening.lat !== null && opening.lng !== null
          ? { lat: opening.lat, lng: opening.lng }
          : KATHMANDU,
        zoom: opening.lat !== null && opening.lng !== null ? PLACED_ZOOM : 13,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        // Google's own POI pins swallow the click that was meant for the map,
        // which reads as the map ignoring you.
        clickableIcons: false,
      })
      map.addListener('click', (event: google.maps.MapMouseEvent) => {
        if (event.latLng) onMoveRef.current(
          roundCoordinate(event.latLng.lat()), roundCoordinate(event.latLng.lng()),
        )
      })
      mapRef.current = map
      geocoderRef.current = new maps.Geocoder()
      autocompleteRef.current = new maps.places.AutocompleteService()
      setReady(true)
      setUnavailable(null)
    }).catch((error: unknown) => {
      if (cancelled) return
      setUnavailable(error instanceof MapsUnavailableError && error.reason === 'no_key'
        ? 'This build has no map key, so enter the coordinates below or paste them from Google Maps.'
        : 'The map could not be loaded. Enter the coordinates below, or try again.')
    })

    return () => { cancelled = true }
  }, [attempt])

  // ── Follow the coordinates ─────────────────────────────────────────────────
  // Separate from construction so a drag moves the marker instead of rebuilding
  // the map underneath the hand that is dragging it.
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return

    if (lat === null || lng === null) {
      markerRef.current?.setMap(null)
      markerRef.current = null
      return
    }

    const position = { lat, lng }
    if (!markerRef.current) {
      markerRef.current = new google.maps.Marker({ map, position, draggable: true })
      markerRef.current.addListener('dragend', () => {
        const moved = markerRef.current?.getPosition()
        if (moved) onMoveRef.current(roundCoordinate(moved.lat()), roundCoordinate(moved.lng()))
      })
    } else {
      markerRef.current.setPosition(position)
    }
    // Panning rather than centring: an author nudging the marker two metres
    // should not have the map jump under them.
    if (!map.getBounds()?.contains(position)) map.panTo(position)
  }, [ready, lat, lng])

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  // ── Reverse geocode ────────────────────────────────────────────────────────
  /**
   * Only when the caller wants the address — a listing's coordinate override
   * has nowhere to put one, and asking Google anyway would be a request whose
   * answer is thrown away.
   */
  const reverseGeocode = useCallback((atLat: number, atLng: number) => {
    const geocoder = geocoderRef.current
    if (!geocoder || !onGeocoded || !venue) return
    setGeocoding(true)
    geocoder.geocode({ location: { lat: atLat, lng: atLng } }, (results, status) => {
      setGeocoding(false)
      const best = results?.[0]
      // A failed reverse geocode is not an error worth showing. The pin is
      // placed either way, which is the part that matters, and Google returns
      // ZERO_RESULTS for plenty of real places in Nepal.
      if (status !== 'OK' || !best) return
      onGeocoded(applyPlaceToVenue(venue, best as PlaceLike, atLat, atLng))
    })
  }, [onGeocoded, venue])

  /**
   * The dropped pin fills the address in by itself — but only the first time.
   *
   * The criterion is that reverse geocoding populates the address from a
   * dropped pin, and a button the author has to find does not do that. Running
   * it on *every* move would, though: it is a billed request per drag, and it
   * would overwrite an address the author had corrected by hand with Google's
   * version of the same place. So it fires when there is no address yet, which
   * is the moment it is unambiguously helpful, and the button below covers
   * asking again on purpose.
   */
  const geocodedAt = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !onGeocoded || !venue || lat === null || lng === null) return
    if (venue.address) return
    const at = `${lat},${lng}`
    if (geocodedAt.current === at) return
    geocodedAt.current = at
    reverseGeocode(lat, lng)
  }, [ready, lat, lng, venue, onGeocoded, reverseGeocode])

  // ── Address search ─────────────────────────────────────────────────────────
  const runSearch = (value: string) => {
    setQuery(value)
    setHighlighted(-1)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.trim().length < 3 || !autocompleteRef.current) {
      setSuggestions([])
      return
    }
    setSearching(true)
    debounceRef.current = setTimeout(() => {
      autocompleteRef.current?.getPlacePredictions(
        { input: value, componentRestrictions: { country: 'np' } },
        (predictions) => {
          setSearching(false)
          setSuggestions(predictions ?? [])
        },
      )
    }, 300)
  }

  const choose = (prediction: google.maps.places.AutocompletePrediction) => {
    setQuery(prediction.structured_formatting.main_text)
    setSuggestions([])
    setHighlighted(-1)
    geocoderRef.current?.geocode({ placeId: prediction.place_id }, (results, status) => {
      const best = results?.[0]
      if (status !== 'OK' || !best?.geometry?.location) return
      const placedLat = roundCoordinate(best.geometry.location.lat())
      const placedLng = roundCoordinate(best.geometry.location.lng())
      onMoveRef.current(placedLat, placedLng)
      mapRef.current?.setZoom(PLACED_ZOOM)
      // The forward geocode already carries the address, so filling the fields
      // from it costs nothing where a reverse geocode would be a second call.
      if (onGeocoded && venue) onGeocoded(applyPlaceToVenue(venue, best as PlaceLike, placedLat, placedLng))
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((index) => Math.min(index + 1, suggestions.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && highlighted >= 0) {
      event.preventDefault()
      const chosen = suggestions[highlighted]
      if (chosen) choose(chosen)
    } else if (event.key === 'Escape') {
      setSuggestions([])
      setHighlighted(-1)
    }
  }

  const setCoordinate = (which: 'lat' | 'lng', raw: string) => {
    if (raw.trim() === '') return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    onMove(
      which === 'lat' ? parsed : lat ?? KATHMANDU.lat,
      which === 'lng' ? parsed : lng ?? KATHMANDU.lng,
    )
  }

  const listboxId = 'map-place-suggestions'

  return (
    <fieldset className="picker">
      <legend className="picker__legend">{label}</legend>

      {ready && (
        <div className="picker__combobox">
          <Field label="Search for an address or a place"
                 hint="Google's places, restricted to Nepal — choosing one drops the pin">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} type="search" autoComplete="off"
                     role="combobox" aria-expanded={suggestions.length > 0}
                     aria-controls={listboxId} aria-autocomplete="list"
                     placeholder="Thamel, Kathmandu…"
                     value={query}
                     onChange={(event) => runSearch(event.target.value)}
                     onKeyDown={onKeyDown} />
            )}
          </Field>
          {suggestions.length > 0 && (
            <ul className="picker__suggestions" id={listboxId} role="listbox"
                aria-label="Matching places">
              {suggestions.map((prediction, index) => (
                <li key={prediction.place_id} role="option" aria-selected={index === highlighted}>
                  <button type="button"
                          className={`picker__suggestion${index === highlighted ? ' is-highlighted' : ''}`}
                          onMouseEnter={() => setHighlighted(index)}
                          onClick={() => choose(prediction)}>
                    <span className="picker__suggestion-name">
                      {prediction.structured_formatting.main_text}
                    </span>
                    <span className="picker__suggestion-detail">
                      {prediction.structured_formatting.secondary_text}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {searching && <p className="picker__searching">Searching…</p>}
        </div>
      )}

      {unavailable
        ? (
          <Alert tone="warning" title="No map here">
            {unavailable}
            {' '}
            <Button type="button" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </Alert>
        )
        : (
          <div className="picker__map-wrap">
            <div ref={containerRef} className="picker__map"
                 role="application"
                 aria-label="Map — click to place the pin, then drag it to adjust" />
            {!ready && <div className="picker__map-loading"><Spinner label="Loading the map" /></div>}
          </div>
        )}

      {ready && (
        <p className="picker__hint">
          Click the map to drop the pin, then drag it to get it exact.
        </p>
      )}

      <div className="wizard__pair">
        <Field label="Latitude">
          {({ id }) => (
            <Input id={id} type="number" step="any" inputMode="decimal"
                   value={lat ?? ''}
                   onChange={(event) => setCoordinate('lat', event.target.value)} />
          )}
        </Field>
        <Field label="Longitude">
          {({ id }) => (
            <Input id={id} type="number" step="any" inputMode="decimal"
                   value={lng ?? ''}
                   onChange={(event) => setCoordinate('lng', event.target.value)} />
          )}
        </Field>
      </div>

      {/* One live region for everything that happens after a pin moves, so a
          screen reader hears the coordinates rather than watching a silent map. */}
      <p className="picker__status" role="status">
        {geocoding
          ? 'Looking up the address…'
          : lat !== null && lng !== null
            ? `Pin at ${formatCoordinates(lat, lng)}`
            : 'No pin placed yet'}
      </p>

      {warning && <Alert tone="warning" title="Check that pin">{warning}</Alert>}

      {onGeocoded && venue && ready && lat !== null && lng !== null && (
        <Button type="button" variant="ghost" onClick={() => reverseGeocode(lat, lng)}>
          Look the address up again
        </Button>
      )}
    </fieldset>
  )
}
