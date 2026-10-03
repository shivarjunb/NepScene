import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useTheme, type ResolvedTheme } from '../theme'
import { mapThemeOptions, type MapThemeOptions } from './mapStyles'

/**
 * A Google map that keeps to the site's theme (see mapStyles.ts).
 *
 * The theme to follow is the *effective* one — the visitor's explicit choice,
 * or the OS's when they have made none — and `ThemeProvider` already resolves
 * it, including the OS changing while the page is open. So following it is
 * one effect on `resolved`, and the map changes in place with `setOptions`:
 * no rebuild, so the viewer keeps where they had panned to and what was open.
 *
 * Returns the options for the theme as it is *when the map is built*, for the
 * constructor to spread. That is the one moment `backgroundColor` counts —
 * Google documents it as read only at construction — and it is what stops a
 * map opened in the dark theme from flashing white while its tiles load. A map
 * switched to dark later keeps the ground it was built on in the gaps until
 * tiles land, which is a moment's grey after a deliberate switch rather than
 * a white flash on every visit.
 */
export function useMapTheme(
  mapRef: RefObject<google.maps.Map | null>,
  ready: boolean,
): () => MapThemeOptions {
  const { resolved } = useTheme()
  // Read by a constructor that runs once, after an asynchronous load — by when
  // the theme the first render saw may no longer be the theme.
  const latest = useRef(resolved)
  latest.current = resolved
  // What the map was last given, so the map becoming ready is not a second
  // restyle of a map that was built in the right theme already.
  const applied = useRef<ResolvedTheme | null>(null)

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || applied.current === resolved) return
    applied.current = resolved
    map.setOptions(mapThemeOptions(resolved))
  }, [mapRef, ready, resolved])

  return useCallback(() => {
    applied.current = latest.current
    return mapThemeOptions(latest.current)
  }, [])
}
