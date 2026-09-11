import { useEffect, useRef, useState } from 'react'
import { fetchSearch } from '../lib/client'
import { mergePins, toMapPins, type MapPin } from './markers'
import { bboxParam, needsFetch, padBounds, tooWide, type Bounds } from './viewport'

/**
 * The map's data source (#36): listings inside the viewport, and no others.
 *
 * The thing this replaces is one line in WaahTickets — `events` handed in as an
 * array of every published event, fetched once at page load. That is the
 * unbounded read the Catalog API was built to prevent (the audit's F4), and it
 * is why the map's cost grew with the catalogue rather than with the screen.
 *
 * Three rules, and the tests in `tests/unit/viewport.test.ts` pin all three:
 *
 * 1. A fetch covers a box **larger** than the viewport, so an ordinary nudge is
 *    already loaded.
 * 2. A pan inside that box fetches **nothing**.
 * 3. Pins already held are **kept**, so a pan that reveals new ground adds to
 *    the map rather than rebuilding it.
 */

/**
 * Pages to walk before stopping. At the API's ceiling of 50 a page, that is 200
 * pins — far more than is legible on one screen, and a hard bound on what a
 * single viewport can cost no matter how dense the area gets.
 */
const MAX_PAGES = 4
const PAGE_LIMIT = '50'

/**
 * How many pins are kept across pans (#39).
 *
 * Keeping them is what stops a pan rebuilding the map and closing the popup
 * somebody is reading. Keeping them *forever* is a leak: pan across Nepal for
 * a minute and the set is every listing in the country, which is the unbounded
 * read the Catalog API exists to prevent, arrived at one viewport at a time.
 *
 * Eight viewports' worth. Past that the oldest go, and if the viewer pans back
 * they are refetched — one request, against an edge cache that almost
 * certainly still has them.
 */
const MAX_HELD_PINS = MAX_PAGES * 50 * 2

export type ViewportListings = {
  pins: MapPin[]
  loading: boolean
  error: string | null
  /** The viewport is too large for "in view" to mean anything (see `tooWide`). */
  wide: boolean
}

export function useViewportListings(viewport: Bounds | null): ViewportListings {
  const [pins, setPins] = useState<MapPin[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** The padded box the held pins cover. Null until the first fetch lands. */
  const loadedRef = useRef<Bounds | null>(null)

  const wide = viewport !== null && tooWide(viewport)

  useEffect(() => {
    if (!viewport || wide) return
    if (!needsFetch(loadedRef.current, viewport)) return

    const box = padBounds(viewport)
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        let cursor: string | undefined

        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await fetchSearch(
            { bbox: bboxParam(box), limit: PAGE_LIMIT, cursor },
            controller.signal,
          )
          if (controller.signal.aborted) return

          // **Progressively (#39).** The first fifty are drawn while the next
          // fifty are still in flight, so a dense area is interactive after one
          // round trip rather than after four. Collecting all four pages and
          // setting state once made the map's time-to-first-pin the sum of
          // every request it was going to make.
          setPins((held) => mergePins(held, toMapPins(result.data), MAX_HELD_PINS))

          if (!result.page.has_more || !result.page.next_cursor) break
          cursor = result.page.next_cursor
        }

        if (controller.signal.aborted) return
        // Recorded only on success. A failed fetch must leave the box unclaimed
        // or the next pan would decide the area was already covered and the
        // map would stay empty until the viewer left the region entirely.
        loadedRef.current = box
      } catch (cause) {
        if (controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : 'Listings could not be loaded')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()

    return () => controller.abort()
  }, [viewport, wide])

  return { pins, loading, error, wide }
}
