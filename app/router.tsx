import { createContext, useContext, useEffect, useRef, useState,
         type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'

/**
 * A minimal history router.
 *
 * Deliberately not react-router, and now deliberately kept. The discovery
 * surface (#41), search (#42), the listing pages (#43) and the entity pages
 * (#44) have all been built on it, and none of them wanted what react-router
 * sells: there are no nested layouts, every dynamic route is one `/thing/:slug`
 * segment, and filters live in the query string on purpose so a refined view
 * can be linked and shared. What is left of the case for a router is code
 * splitting, which belongs to the bundle rather than to the routing model —
 * and landed that way, as `deferred()` routes in `routes.tsx` (#39).
 *
 * It exists because the shell's navigation (#18) was lying: before it, every
 * link in the header and footer full-page-reloaded back into the design system,
 * because the SPA fallback serves index.html for every path and index.html
 * rendered the gallery unconditionally.
 *
 * Server rendering (#45) did reopen it, and the table held: the router now
 * takes its opening location as a prop instead of reading `window`, which is
 * the whole of what it needed to run in a Worker.
 */

/** Trailing slashes are not a different page. `/` itself keeps its slash. */
const normalise = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

type Location = { path: string; search: string }

/**
 * A location can carry an *overlay*: a second location shown in a dialog over
 * the page, which is how a listing opens from a card (#43). The address bar
 * holds the overlay — `/listings/<slug>`, so the link is shareable and Back
 * closes it — while `path` and `search` stay those of the page underneath, so
 * everything that reads the route keeps rendering that page.
 *
 * The page underneath is remembered in `history.state`, which is the only
 * place that survives Back and Forward but not a reload: a reload lands on
 * the listing's own page, which is what the address says it is.
 */
type Current = Location & { overlay?: Location }

type OverlayState = { background: Location; depth: number }

const overlayState = (): OverlayState | null => {
  const state: unknown = window.history.state
  if (!state || typeof state !== 'object') return null
  const { background, depth } = state as Partial<OverlayState>
  if (!background || typeof background.path !== 'string' || typeof background.search !== 'string') return null
  return { background, depth: typeof depth === 'number' ? depth : 1 }
}

const here = (): Location => ({
  path: normalise(window.location.pathname),
  search: window.location.search,
})

/**
 * Where the browser currently is. Only ever called in a browser — the server
 * passes its location in, because there is no `window` to ask.
 */
const read = (): Current => {
  const overlay = overlayState()
  return overlay ? { ...overlay.background, overlay: here() } : here()
}

/** Splits a URL the server has into the shape the context holds. */
export function locationOf(url: string): Location {
  const parsed = new URL(url)
  return { path: normalise(parsed.pathname), search: parsed.search }
}

const RouteContext = createContext<Current>({ path: '/', search: '' })

/** The path alone — what picks the page. */
export const useRoute = () => useContext(RouteContext).path

/** The location shown in a dialog over the page, if there is one. */
export const useOverlay = () => useContext(RouteContext).overlay ?? null

/**
 * The query string, parsed. Filters live here rather than in component state so
 * a filtered view can be linked to, shared and reloaded — the WaahTickets
 * storefront kept them in React state, and every filtered page was the
 * homepage again when you sent it to someone.
 */
export function useSearch() {
  return new URLSearchParams(useContext(RouteContext).search)
}

export function navigate(to: string, { replace = false, overlay = false } = {}) {
  const target = new URL(to, window.location.href)
  const current = window.location
  // Compares the query too: /?category=film and /?category=comedy are different
  // pages, and a rail's "see all" link is exactly that case.
  if (normalise(target.pathname) === normalise(current.pathname)
      && target.search === current.search) return

  if (overlay) {
    // Opening one overlay from another — a related listing from inside the
    // dialog — keeps the original page underneath and counts the depth, so
    // closing goes back to the page rather than to the previous overlay.
    const open = overlayState()
    const state: OverlayState = open
      ? { background: open.background, depth: open.depth + 1 }
      : { background: here(), depth: 1 }
    window.history.pushState(state, '', to)
  } else {
    // A plain navigation from inside an overlay closes it: the new entry has
    // no page underneath, so the dialog has nothing to sit over.
    window.history[replace ? 'replaceState' : 'pushState'](null, '', to)
  }
  // pushState fires no event of its own; the listener below is what re-renders.
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/**
 * Closes the overlay by going back to the page underneath it, however many
 * overlays deep — which is also exactly what the Back button does from the
 * first of them, so there is one way out rather than two that differ.
 */
export function closeOverlay() {
  const open = overlayState()
  if (open) window.history.go(-open.depth)
}

/**
 * The element whose click opened the overlay, for focus to return to when it
 * closes. A focus trap remembers `document.activeElement`, but WebKit does
 * not focus a link on a mouse click, so from a card in Safari that is the
 * body. Recorded only for the first overlay: one opened from inside another
 * is gone by the time the reader is back on the page.
 */
let opener: HTMLElement | null = null
export const overlayOpener = () => opener

export function Router({ initial, children }: { initial?: Location; children: ReactNode }) {
  /**
   * The opening location is given, not read, when there is one. On the server
   * there is no `window`; in the browser the value handed in is the one the
   * server rendered, and reading `window` again during hydration would be the
   * same answer arrived at less reliably.
   */
  const [location, setLocation] = useState<Current>(() => initial ?? read())

  useEffect(() => {
    const onPopState = () => setLocation(read())
    window.addEventListener('popstate', onPopState)
    // A reload of an overlay entry is the listing's own page: the server
    // rendered that, and it is what the address bar says. Dropping the state
    // makes the entry agree, so Back from here is a step back, not a close.
    if (overlayState()) window.history.replaceState(null, '', window.location.href)
    // Catches the case where the browser is already somewhere else by the time
    // the bundle runs — a link followed during the download.
    setLocation(read())
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return <RouteContext.Provider value={location}>{children}</RouteContext.Provider>
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
  /** Opens the destination in a dialog over this page rather than in its place. */
  overlay?: boolean
}

/**
 * An anchor first and a router link second: it keeps a real href, so middle
 * click, ctrl-click and "copy link address" all behave, and only takes over the
 * plain left click that would otherwise reload the document. An `overlay` link
 * is still that anchor — a new tab gets the full page — and only the plain
 * click differs.
 */
export function Link({ href, onClick, overlay = false, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (rest.target && rest.target !== '_self') return
    event.preventDefault()
    if (overlay && !overlayState()) opener = event.currentTarget
    navigate(href, { overlay })
  }

  return <a href={href} onClick={handleClick} {...rest} />
}

/**
 * A client-side navigation replaces the page without the browser's usual reset,
 * which leaves focus on the link that was clicked and the viewport wherever it
 * was. A screen reader is then told nothing has happened. Moving focus to the
 * main landmark is what makes the new page announce itself.
 *
 * The first render is skipped on purpose: stealing focus on load would break
 * the skip link, which has to be the first thing Tab reaches.
 */
export function useRouteFocus(path: string) {
  const firstRender = useRef(true)

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    window.scrollTo(0, 0)
    document.getElementById('main')?.focus()
  }, [path])
}
