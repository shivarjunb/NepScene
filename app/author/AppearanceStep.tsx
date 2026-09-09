import { useEffect, useRef, useState } from 'react'
import { Alert, Badge, Button, Input } from '../components/primitives'
import { loadGoogleMaps } from '../lib/googleMaps'
import { ListingPopup, type PopupListing } from '../map/ListingPopup'
import { PIN_SIZE, pinDataUri, pinSvg } from '../map/pinMarker'
import {
  defaultPopupConfig, isDefaultPopupConfig, parsePopupConfig, serialisePopupConfig,
  type PopupField,
} from '../../api/author/popupConfig'
import { resolvePin } from '../../api/catalog/pin'
import type { ListingInput } from '../../api/author/validate'
import type { Lookups } from '../lib/author'

/**
 * The "On the map" step (#32): what the pin looks like, and what the popup
 * says.
 *
 * **The pin is not editable, and that is the ported decision rather than an
 * omission.** WaahTickets let an author choose an icon and a colour
 * independently of the event's category, which is why its map needed a
 * separate `pinCategory` concept to reconcile the pin with the filter chips —
 * and the two drifted apart anyway. NepScene derives appearance from the
 * primary category (`resolvePin`), so the chip and the pin are one value read
 * twice. What is shown here is therefore a *consequence*, with a route back to
 * the thing that decides it.
 *
 * **The preview is the real components on a real map.** The pin is the same
 * SVG the map draws, the card is the same `ListingPopup` #36 will mount, and
 * the map is a `google.maps.Map`. WaahTickets' preview built an HTML string
 * for a pin its own map never rendered; the only way "previews accurately" is
 * a testable claim is if there is nothing separate to be accurate about.
 */

type Props = {
  listing: ListingInput
  set: (patch: Partial<ListingInput>) => void
  lookups: Lookups
}

export function AppearanceStep({ listing, set, lookups }: Props) {
  const primary = lookups.categories.find((c) => c.slug === listing.primary_category_slug)
  const pin = resolvePin(
    primary
      ? [{
          slug: primary.slug, name: primary.name,
          icon: primary.icon, color: primary.color, is_primary: true,
        }]
      : [],
  )

  const config = parsePopupConfig(listing.map_popup_config)
  const customised = !isDefaultPopupConfig(config)

  /**
   * Every change goes back through `serialisePopupConfig`, so a config the
   * author has fiddled back into the default shape is stored as `null` — which
   * is what makes "reset" a clearing rather than a copy of today's defaults
   * frozen onto the row.
   */
  const update = (fields: PopupField[]) =>
    set({ map_popup_config: serialisePopupConfig({ fields }) })

  const move = (index: number, by: -1 | 1) => {
    const next = [...config.fields]
    const target = index + by
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    update(next)
  }

  const preview: PopupListing = {
    slug: 'preview',
    title: listing.title || 'Your listing',
    pin,
    venue: lookups.venues.find((v) => v.id === listing.venue_id)?.name ?? 'The venue you chose',
    when: listing.starts_at
      ? new Intl.DateTimeFormat('en-GB', {
          dateStyle: 'medium', timeStyle: 'short', timeZone: listing.timezone,
        }).format(new Date(listing.starts_at))
      : 'The date you chose',
    category: primary?.name ?? null,
    summary: listing.summary ?? 'Your one-line summary appears here.',
    offer: listing.offer_url
      ? { label: 'Tickets available', url: listing.offer_url }
      : { label: listing.listing_type === 'free' ? 'Free to attend' : 'Entry details', url: null },
  }

  return (
    <div className="appearance">
      {!primary && (
        <Alert tone="warning" title="No main category">
          Go back to the first step and pick one — your pin takes its colour and
          icon from it, and without one your listing sits under no filter.
        </Alert>
      )}

      <div className="appearance__pin-row">
        <span
          className="appearance__pin"
          // The marker image itself, at the size the map draws it.
          dangerouslySetInnerHTML={{ __html: pinSvg(pin) }}
          aria-hidden="true"
        />
        <p className="appearance__legend">
          Your pin is {primary ? <Badge tone="accent">{primary.name}</Badge> : 'the default'}.
          {' '}
          Colour and icon come from the main category so the map and the filter
          chips always agree — change the category to change the pin.
        </p>
      </div>

      <div className="appearance__split">
        <div>
          <h3 className="wizard__heading">What the popup shows</h3>
          <ul className="appearance__fields">
            {config.fields.map((field, index) => (
              <li key={field.field}
                  className={`appearance__field${field.visible ? '' : ' is-hidden'}`}>
                <span className="appearance__move">
                  <button type="button" disabled={index === 0}
                          aria-label={`Move ${field.label} up`}
                          onClick={() => move(index, -1)}>▲</button>
                  <button type="button" disabled={index === config.fields.length - 1}
                          aria-label={`Move ${field.label} down`}
                          onClick={() => move(index, 1)}>▼</button>
                </span>

                <Input aria-label={`Label for ${field.field}`} value={field.label}
                       maxLength={24}
                       onChange={(event) => update(config.fields.map((entry, i) =>
                         i === index ? { ...entry, label: event.target.value } : entry))} />

                <Button type="button" size="sm"
                        variant={field.visible ? 'secondary' : 'ghost'}
                        aria-pressed={field.visible}
                        onClick={() => update(config.fields.map((entry, i) =>
                          i === index ? { ...entry, visible: !entry.visible } : entry))}>
                  {field.visible ? 'Shown' : 'Hidden'}
                </Button>
              </li>
            ))}
          </ul>

          <Button type="button" variant="ghost" disabled={!customised}
                  onClick={() => update(defaultPopupConfig().fields)}>
            Reset to the defaults
          </Button>
        </div>

        <div className="appearance__preview">
          <h3 className="wizard__heading">Preview</h3>
          <PinPreview pin={pin}
                      lat={listing.location_lat} lng={listing.location_lng} />
          <ListingPopup listing={preview} config={config} />
        </div>
      </div>
    </div>
  )
}

/**
 * A real map with the real marker on it, or nothing at all.
 *
 * There is no fallback rendering of the pin over a grey rectangle, unlike the
 * location picker's fallback to typed coordinates. The picker degrades because
 * an author with no map key must still be able to *set* a location; this only
 * shows what something will look like, and a mock-up of a map is precisely the
 * approximation this component exists to stop being.
 */
function PinPreview({ pin, lat, lng }: {
  pin: ReturnType<typeof resolvePin>
  lat: number | null
  lng: number | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markerRef = useRef<google.maps.Marker | null>(null)
  const [ready, setReady] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const centre = { lat: lat ?? 27.7172, lng: lng ?? 85.324 }

  useEffect(() => {
    let cancelled = false
    loadGoogleMaps().then((maps) => {
      if (cancelled || !containerRef.current || mapRef.current) return
      mapRef.current = new maps.Map(containerRef.current, {
        center: centre, zoom: 15,
        disableDefaultUI: true,
        // It is a picture, not a map. Letting somebody pan it invites them to
        // try to move the pin, which is the previous step's job.
        gestureHandling: 'none',
        keyboardShortcuts: false,
      })
      setReady(true)
    }).catch(() => { if (!cancelled) setUnavailable(true) })
    return () => { cancelled = true }
    // Built once; the marker effect below follows the values.
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    map.setCenter(centre)
    markerRef.current?.setMap(null)
    markerRef.current = new google.maps.Marker({
      map,
      position: centre,
      icon: {
        url: pinDataUri(pin),
        scaledSize: new google.maps.Size(PIN_SIZE, PIN_SIZE),
        // The point of a teardrop is the point: anchor at the tip, not the
        // centre, or every pin sits twenty pixels north of its venue.
        anchor: new google.maps.Point(PIN_SIZE / 2, PIN_SIZE),
      },
    })
  }, [ready, pin.color, pin.icon, centre.lat, centre.lng])

  if (unavailable) {
    return (
      <p className="appearance__legend">
        The map preview needs a Google Maps key, which this build has not got.
        The pin above is exactly what will be drawn.
      </p>
    )
  }

  return <div ref={containerRef} className="appearance__map"
              role="img" aria-label="Preview of your pin on the map" />
}
