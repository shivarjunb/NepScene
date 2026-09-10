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
 * splitting, which belongs to the bundle rather than to the routing model.
 *
 * It exists because the shell's navigation (#18) was lying: before it, every
 * link in the header and footer full-page-reloaded back into the design system,
 * because the SPA fallback serves index.html for every path and index.html
 * rendered the gallery unconditionally.
 *
 * Server rendering (#45) is the change that will reopen this, since it needs
 * the route table on both sides — which is why `routes.tsx` is a table rather
 * than a switch.
 */

/** Trailing slashes are not a different page. `/` itself keeps its slash. */
const normalise = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

type Location = { path: string; search: string }

const read = (): Location => ({
  path: normalise(window.location.pathname),
  search: window.location.search,
})

const RouteContext = createContext<Location>({ path: '/', search: '' })

/** The path alone — what picks the page. */
export const useRoute = () => useContext(RouteContext).path

/**
 * The query string, parsed. Filters live here rather than in component state so
 * a filtered view can be linked to, shared and reloaded — the WaahTickets
 * storefront kept them in React state, and every filtered page was the
 * homepage again when you sent it to someone.
 */
export function useSearch() {
  return new URLSearchParams(useContext(RouteContext).search)
}

export function navigate(to: string, { replace = false } = {}) {
  const target = new URL(to, window.location.href)
  const current = window.location
  // Compares the query too: /?category=film and /?category=comedy are different
  // pages, and a rail's "see all" link is exactly that case.
  if (normalise(target.pathname) === normalise(current.pathname)
      && target.search === current.search) return

  window.history[replace ? 'replaceState' : 'pushState'](null, '', to)
  // pushState fires no event of its own; the listener below is what re-renders.
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(read)

  useEffect(() => {
    const onPopState = () => setLocation(read())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return <RouteContext.Provider value={location}>{children}</RouteContext.Provider>
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }

/**
 * An anchor first and a router link second: it keeps a real href, so middle
 * click, ctrl-click and "copy link address" all behave, and only takes over the
 * plain left click that would otherwise reload the document.
 */
export function Link({ href, onClick, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (rest.target && rest.target !== '_self') return
    event.preventDefault()
    navigate(href)
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
