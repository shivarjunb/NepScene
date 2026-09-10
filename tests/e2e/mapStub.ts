import type { Page } from '@playwright/test'

/**
 * The public map's two dependencies, both stubbed at the boundary (#36):
 * Google's SDK, and the Catalog API.
 *
 * The Playwright server is `vite preview` — the built SPA and no Worker — and
 * the build has no Maps key, which is exactly the state a preview deployment
 * is in. So neither can be real here. That is not a compromise for this spec:
 * the criteria it settles are *panning fetches the new viewport and not the
 * whole catalogue* and *a popup leads to the listing*, and both are claims
 * about the requests the app makes and the DOM it puts up. Whether Google
 * draws tiles is Google's business.
 *
 * The API side of the same rules runs against a real D1 in
 * `tests/integration/mapViewport.test.ts`, and the viewport arithmetic under
 * them is unit-tested in `tests/unit/viewport.test.ts`.
 */

/** Kathmandu and Pokhara, the same two places the D1 seed uses. */
export const THAMEL = { lat: 27.7154, lng: 85.3105 }
export const POKHARA = { lat: 28.2096, lng: 83.9556 }

const listing = (
  over: Record<string, unknown> & { id: string; latitude: number; longitude: number },
) => ({
  slug: over.id,
  title: over.id,
  summary: 'Something happening.',
  listing_type: 'free',
  source: 'organizer',
  starts_at: '2027-03-14T13:15:00.000Z',
  ends_at: null,
  is_all_day: false,
  timezone: 'Asia/Kathmandu',
  cover_image_url: null,
  external_url: null,
  is_featured: false,
  map_popup_config: null,
  pin: { icon: 'Music', color: '#e91e63', category: 'concerts' },
  cover: null,
  venue: { id: 'v', slug: 'purple-haze', name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu' },
  organizer: null,
  categories: [
    { slug: 'concerts', name: 'Concerts', color: '#e91e63', icon: 'Music', is_primary: true },
  ],
  offer: null,
  ...over,
})

const venue = (id: string, slug: string, name: string, area: string, city: string) =>
  ({ id, slug, name, area, city })

const PURPLE_HAZE = venue('v_purple', 'purple-haze', 'Purple Haze', 'Thamel', 'Kathmandu')
const PATAN = venue('v_patan', 'patan-durbar', 'Patan Durbar Square', 'Mangal Bazaar', 'Lalitpur')
const LAKESIDE = venue('v_lakeside', 'lakeside', 'Lakeside', 'Baidam', 'Pokhara')

/**
 * Two listings at Purple Haze and one at Patan — so Kathmandu is three
 * listings and *two* pins, which is what makes the grouping (#37) visible
 * end to end rather than only in a unit test.
 */
export const KATHMANDU_LISTINGS = [
  listing({
    id: 'rock-night', title: 'Rock Night', venue: PURPLE_HAZE,
    latitude: THAMEL.lat, longitude: THAMEL.lng,
    starts_at: '2027-03-14T13:15:00.000Z',
  }),
  listing({
    id: 'late-set', title: 'Late Set', venue: PURPLE_HAZE,
    latitude: THAMEL.lat, longitude: THAMEL.lng,
    // Later than Rock Night, so the tuned order has something to order.
    starts_at: '2027-03-21T15:00:00.000Z',
  }),
  listing({
    id: 'art-week', title: 'Art Week', venue: PATAN,
    latitude: 27.70, longitude: 85.32,
  }),
]

export const POKHARA_LISTINGS = [
  listing({
    id: 'lakeside-live', title: 'Lakeside Live', venue: LAKESIDE,
    latitude: POKHARA.lat, longitude: POKHARA.lng,
  }),
]

/** What a grouped pin's marker is titled, and therefore what a spec clicks. */
export const PURPLE_HAZE_PIN = 'Purple Haze, Thamel — 2 listings'

/**
 * Serves `/api/catalog/search` from whichever region the bbox covers, and
 * records every bbox it was asked for — which is how a spec can assert that a
 * pan fetched once and a nudge fetched not at all.
 */
export async function serveMapCatalog(page: Page) {
  const requested: string[] = []

  await page.route('**/api/catalog/search*', (route) => {
    const bbox = new URL(route.request().url()).searchParams.get('bbox') ?? ''
    requested.push(bbox)

    const [, south, , north] = bbox.split(',').map(Number)
    const covers = (lat: number) => lat >= south && lat <= north
    const data = covers(THAMEL.lat) ? KATHMANDU_LISTINGS
      : covers(POKHARA.lat) ? POKHARA_LISTINGS
      : []

    return route.fulfill({
      json: { data, page: { limit: 50, has_more: false, next_cursor: null } },
    })
  })

  return { requested: () => requested }
}

/**
 * A `google.maps` that draws nothing but keeps a viewport.
 *
 * Richer than the authoring stub's, which only ever needed a map that could be
 * clicked: this one holds bounds, reports them through `getBounds`, fires
 * `idle` the way the SDK does after a pan, and provides the `OverlayView`
 * projection the popup is positioned with.
 */
export async function stubMapsSdk(page: Page) {
  await page.addInitScript(() => {
    type Listener = (event: unknown) => void
    const mapListeners: Record<string, Listener[]> = {}
    const markerListeners = new Map<unknown, Listener[]>()

    class FakeLatLng {
      constructor(private readonly a: number, private readonly b: number) {}
      lat() { return this.a }
      lng() { return this.b }
    }

    /** Half a degree each way — a plausible city-scale viewport. */
    let centre = { lat: 27.7172, lng: 85.324 }
    const SPAN = 0.09

    class FakeBounds {
      getNorthEast() { return new FakeLatLng(centre.lat + SPAN, centre.lng + SPAN) }
      getSouthWest() { return new FakeLatLng(centre.lat - SPAN, centre.lng - SPAN) }
    }

    class FakeMap {
      constructor(container: HTMLElement) {
        container.dataset.fakeMap = 'ready'
        // The SDK settles asynchronously and then fires `idle`; the app's first
        // fetch hangs off that, so the stub has to do the same.
        setTimeout(() => fire('idle', undefined), 0)
      }
      addListener(event: string, handler: Listener) {
        (mapListeners[event] ??= []).push(handler)
        return { remove: () => {} }
      }
      getBounds() { return new FakeBounds() }
      setCenter() {}
      setZoom() {}
      panTo() {}
    }

    class FakeMarker {
      constructor(readonly options: { position: { lat: number; lng: number }; title?: string }) {
        markers.push(this)
      }
      addListener(_event: string, handler: Listener) {
        markerListeners.set(this, [...(markerListeners.get(this) ?? []), handler])
        return { remove: () => {} }
      }
      setMap(map: unknown) {
        // The real SDK drops a marker off the map when it is handed null, and
        // the component relies on that to tear one down. A stub that kept it
        // would let a stale count survive a redraw and nothing would notice.
        if (map !== null) return
        const at = markers.indexOf(this)
        if (at >= 0) markers.splice(at, 1)
      }
      getPosition() {
        return new FakeLatLng(this.options.position.lat, this.options.position.lng)
      }
    }

    class FakeOverlayView {
      onAdd = () => {}
      draw = () => {}
      onRemove = () => {}
      setMap() {}
      getProjection() {
        return {
          // Any stable mapping will do: the spec asserts the popup is placed,
          // not where. Real placement is Google's arithmetic, not ours.
          fromLatLngToContainerPixel: () => ({ x: 200, y: 180 }),
        }
      }
    }

    class FakeSize { constructor(readonly width: number, readonly height: number) {} }
    class FakePoint { constructor(readonly x: number, readonly y: number) {} }

    const markers: FakeMarker[] = []
    const fire = (event: string, payload: unknown) => {
      for (const handler of mapListeners[event] ?? []) handler(payload)
    }

    const win = window as unknown as Record<string, unknown>
    win.google = {
      maps: {
        Map: FakeMap,
        Marker: FakeMarker,
        OverlayView: FakeOverlayView,
        LatLng: FakeLatLng,
        Size: FakeSize,
        Point: FakePoint,
        event: { trigger: () => {} },

        /** The spec's handles on gestures the SDK would otherwise own. */
        __panTo: (lat: number, lng: number) => {
          centre = { lat, lng }
          fire('idle', undefined)
        },
        __nudge: () => {
          // A twentieth of the span: well inside the padded box, so the app
          // should decide this costs no request at all.
          centre = { lat: centre.lat + SPAN / 20, lng: centre.lng }
          fire('idle', undefined)
        },
        __clickMarker: (title: string) => {
          const marker = markers.find((m) => m.options.title === title)
          if (!marker) throw new Error(`no marker titled ${title}`)
          for (const handler of markerListeners.get(marker) ?? []) handler(undefined)
        },
        __markerTitles: () => markers.map((m) => m.options.title),
      },
    }
  })
}
