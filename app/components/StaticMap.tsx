import { useEffect, useRef, useState } from 'react'
import type { PinAppearance } from '../lib/catalog'
import { loadGoogleMaps, mapsApiKey } from '../lib/googleMaps'
import { pinDataUri, PIN_SIZE } from '../map/pinMarker'

/**
 * One place, on one small map (#43, #44).
 *
 * Not the `NepalMap`. That component owns a viewport, fetches listings as it
 * pans and is the whole point of the `/map` page; here the map is a *locator*
 * — it answers "where is this" and nothing else — so it is fixed, silent and
 * carries a single pin. Reusing the discovery map would have made every
 * listing page mount viewport fetching it never uses.
 *
 * **It is decorative, and the page works without it.** The address, the venue
 * link and the directions button are all rendered next to it and are what a
 * screen reader gets (#40's non-map fallback, applied to a page rather than to
 * the map itself). So the map is `aria-hidden`, and on a build with no Maps
 * key — every preview deployment, and the Playwright server — nothing is drawn
 * at all rather than an error being reported for a picture.
 */
export function StaticMap({ latitude, longitude, label, pin }: {
  latitude: number | null
  longitude: number | null
  label: string
  pin?: PinAppearance
}) {
  const container = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (latitude === null || longitude === null || !mapsApiKey()) return
    let cancelled = false

    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !container.current) return
        const position = { lat: latitude, lng: longitude }
        const map = new maps.Map(container.current, {
          center: position,
          zoom: 15,
          disableDefaultUI: true,
          // Zoom is left on: a locator map is useless if you cannot see what
          // is around the pin, and pinch-zoom is the one gesture people try.
          zoomControl: true,
          gestureHandling: 'cooperative',
        })
        // The same pin the discovery map draws (#32), from the same SVG, so a
        // listing looks like itself wherever it appears.
        new maps.Marker({
          map, position, title: label,
          ...(pin ? { icon: {
            url: pinDataUri(pin),
            scaledSize: new maps.Size(PIN_SIZE, PIN_SIZE),
            anchor: new maps.Point(PIN_SIZE / 2, PIN_SIZE),
          } } : {}),
        })
        setReady(true)
      })
      .catch(() => {
        // No key, or the script did not load. The address beside it is the
        // page's actual answer to "where"; this was only ever the picture.
      })

    return () => { cancelled = true }
  }, [latitude, longitude, label, pin])

  if (latitude === null || longitude === null || !mapsApiKey()) return null

  return (
    <div
      ref={container}
      className={`static-map ${ready ? '' : 'static-map--loading'}`}
      aria-hidden="true"
    />
  )
}
