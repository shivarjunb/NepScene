/**
 * The Maps JavaScript API, loaded once per page (#31).
 *
 * WaahTickets used `@googlemaps/js-api-loader` for this. That package is a
 * script tag, a promise and a guard against loading twice, which is what is
 * below; carrying a dependency across for it would add a package to the bundle
 * to save thirty lines and would still need this file to hold the key policy.
 *
 * The key is `VITE_GOOGLE_MAPS_API_KEY`: a build-time public value, restricted
 * by HTTP referrer per environment (docs/DEVOPS.md > Secrets). It is on the
 * page by construction — the map cannot draw without it — which is the whole
 * reason geocoding stays in the browser rather than behind a Worker endpoint
 * (docs/ARCHITECTURE.md > Geocoding stays in the browser).
 *
 * **A missing key is a state, not a crash.** Preview builds and the Playwright
 * server have no key, and an author on one of them must still be able to set a
 * location — so this rejects with a `MapsUnavailableError` that callers render
 * as the manual coordinate fallback rather than as an error.
 */

export class MapsUnavailableError extends Error {
  constructor(readonly reason: 'no_key' | 'load_failed', message: string) {
    super(message)
    this.name = 'MapsUnavailableError'
  }
}

/** The libraries the picker needs, and nothing else — each one is bytes. */
const LIBRARIES = ['places', 'geometry'] as const

let pending: Promise<typeof google.maps> | null = null

export function mapsApiKey(): string | null {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : null
}

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (typeof window === 'undefined') {
    return Promise.reject(new MapsUnavailableError('no_key', 'Maps only load in a browser'))
  }
  // Already there: a second wizard step, or a test that installed a stub.
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps)
  if (pending) return pending

  const key = mapsApiKey()
  if (!key) {
    return Promise.reject(new MapsUnavailableError(
      'no_key', 'This build has no Google Maps key, so the map cannot be shown',
    ))
  }

  pending = new Promise<typeof google.maps>((resolve, reject) => {
    // Google calls a global by name when the API is ready. `loading=async` is
    // what stops the console warning that the script was loaded synchronously,
    // and it makes the callback the only reliable readiness signal — `onload`
    // fires before the libraries are attached.
    const callback = `__nepsceneMapsReady_${Date.now().toString(36)}`
    const globals = window as unknown as Record<string, unknown>

    const cleanUp = () => { delete globals[callback] }

    globals[callback] = () => {
      cleanUp()
      resolve(window.google!.maps)
    }

    const script = document.createElement('script')
    const params = new URLSearchParams({
      key,
      v: 'weekly',
      libraries: LIBRARIES.join(','),
      loading: 'async',
      callback,
      // Nepali place names come back in Nepali otherwise on a Nepali browser,
      // and the author is typing an address they read off a poster in English.
      language: 'en',
      region: 'NP',
    })
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`
    script.async = true
    script.onerror = () => {
      cleanUp()
      // Cleared so a later attempt — the author fixing their connection and
      // pressing Retry — is not answered from a cached rejection forever.
      pending = null
      reject(new MapsUnavailableError('load_failed', 'The map could not be loaded'))
    }
    document.head.appendChild(script)
  })

  return pending
}

/** Test seam: forget any in-flight load so a stub can take over. */
export function resetGoogleMapsForTests() {
  pending = null
}

declare global {
  // The SDK attaches itself to the window; `@types/google.maps` declares the
  // namespace but not that property, because how the script gets there is the
  // loader's business.
  interface Window {
    google?: typeof globalThis.google
  }
}
