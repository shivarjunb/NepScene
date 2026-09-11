import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchHere } from '../lib/client'
import { DEFAULT_CITY, resolveCity, type NepalCity } from '../../api/lib/cities'
import { useLanguage } from '../i18n'

/**
 * Where the viewer is, resolved in stages (#38).
 *
 * The staging is the good idea WaahTickets had and is carried over intact:
 * browser geolocation, then the IP, then Kathmandu. What each stage is worth
 * is quite different, and the design respects that — the browser gives you a
 * position accurate enough to sort listings by distance; the IP gives you a
 * city to name in a headline and nothing more; the default gives you a map
 * that opens somewhere plausible rather than on the Atlantic.
 *
 * Three things changed on the way across.
 *
 * **The IP stage works now.** It called `http://ip-api.com` from a page served
 * over HTTPS, which browsers block as mixed content, so in production the
 * "three-stage" resolution had two stages. It is a same-origin call to our own
 * Worker now (`api/catalog/here.ts`), which reads what Cloudflare already
 * resolved before the request arrived.
 *
 * **The browser stage is asked once, not watched.** The original called
 * `watchPosition` with `enableHighAccuracy: true` and never cleared it except
 * on unmount — a continuously-running GPS fix, on a phone, to draw a headline.
 * `getCurrentPosition` answers the question being asked.
 *
 * **There is a timeout.** The issue names six seconds and the original had
 * none: `watchPosition` with no `timeout` waits forever on a permission
 * prompt nobody answers, and the IP fallback it was supposed to have would
 * never fire.
 */

/** Long enough for a real GPS fix on a phone, short enough not to be a hang. */
const GEOLOCATION_TIMEOUT_MS = 6000

/**
 * A cached fix is fine for this. The question is "which city, and roughly
 * where" — an answer from two minutes ago is the same answer, and reusing it
 * skips the prompt and the radio.
 */
const MAX_AGE_MS = 120_000

export type Coords = { lat: number; lng: number }

export type LocationStage = 'idle' | 'locating' | 'precise' | 'ip' | 'default'

export type ResolvedLocation = {
  /** Never null. The default is a real answer, not an absence of one. */
  centre: Coords
  /** In the reader's language (#46), which is why the hook needs to know it. */
  city: string
  stage: LocationStage
  /**
   * True only for a browser-granted position. Distance filtering is offered
   * only here: filtering "within 2km" around a geo-IP centroid would be
   * arithmetic on a number that does not mean what it says.
   */
  precise: boolean
  /** The viewer refused, or the browser has no geolocation at all. */
  denied: boolean
  /** Ask the browser. Safe to call again after a denial. */
  locate: () => void
}

export function useLocation(): ResolvedLocation {
  const { language } = useLanguage()
  const [centre, setCentre] = useState<Coords>({ lat: DEFAULT_CITY.lat, lng: DEFAULT_CITY.lng })
  /**
   * Both spellings, chosen at render. Storing the *chosen* one would strand a
   * reader who switches language after the city resolved on whichever
   * spelling happened to be current when it did.
   */
  const [names, setNames] = useState<{ en: string; ne: string }>(
    { en: DEFAULT_CITY.name, ne: DEFAULT_CITY.name_ne },
  )
  const [stage, setStage] = useState<LocationStage>('idle')
  const [denied, setDenied] = useState(false)

  /**
   * Set once a browser position lands. The IP request is in flight at the same
   * time and is the slower, worse answer; without this it can arrive second
   * and overwrite a precise fix with a city centroid.
   */
  const preciseRef = useRef(false)

  // ── Stage two, immediately: the IP ─────────────────────────────────────────
  // Started at mount rather than after a geolocation failure, because the two
  // are independent and serialising them would put a six-second timeout in
  // front of a request that takes ten milliseconds.
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const here = await fetchHere(controller.signal)
        if (controller.signal.aborted || preciseRef.current) return
        setCentre({ lat: here.lat, lng: here.lng })
        setNames({ en: here.city, ne: here.city_ne })
        setStage(here.source === 'ip' ? 'ip' : 'default')
      } catch {
        // Not an error path worth showing anybody. The default is already on
        // screen and is a usable map; a banner saying we could not guess the
        // city would be noise about a thing nobody asked for.
        if (!controller.signal.aborted && !preciseRef.current) setStage('default')
      }
    })()
    return () => controller.abort()
  }, [])

  // ── Stage one, on request: the browser ─────────────────────────────────────
  const locate = useCallback(() => {
    // Truthiness, not `in`: a browser that exposes the property and leaves it
    // undefined — and privacy builds that do exactly this — would pass an
    // `in` check and then throw on the call.
    if (!navigator.geolocation) {
      setDenied(true)
      return
    }
    setStage('locating')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        preciseRef.current = true
        setCentre({ lat: latitude, lng: longitude })
        // Named from the coordinate, using the same twenty-city table the
        // server used — so granting permission cannot rename the city the
        // headline was already showing into something from a different list.
        setNames(namesOf(resolveCity(null, latitude, longitude)))
        setStage('precise')
        setDenied(false)
      },
      () => {
        // A denial is not an error to report. Whatever the IP stage found is
        // already on screen and the map is already usable; the only thing that
        // changes is that distance filtering stays unavailable.
        setDenied(true)
        setStage((current) => (current === 'locating' ? 'default' : current))
      },
      { enableHighAccuracy: false, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: MAX_AGE_MS },
    )
  }, [])

  return {
    centre,
    city: language === 'ne' ? names.ne : names.en,
    stage,
    precise: stage === 'precise',
    denied,
    locate,
  }
}

const namesOf = (city: NepalCity) => ({ en: city.name, ne: city.name_ne })
