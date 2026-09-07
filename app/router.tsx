import { createContext, useContext, useEffect, useRef, useState,
         type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'

/**
 * A minimal history router.
 *
 * Deliberately not react-router. The routing model belongs to the discovery
 * surface (#41) and the listing pages (#43) — nested layouts, loaders, search
 * params and code splitting are all decisions those features get to make. This
 * exists so the shell's navigation (#18) stops lying: before it, every link in
 * the header and footer full-page-reloaded back into the design system, because
 * the SPA fallback serves index.html for every path and index.html rendered the
 * gallery unconditionally.
 *
 * Sixty lines with no dependency is cheap to delete when #41 chooses properly.
 */

/** Trailing slashes are not a different page. `/` itself keeps its slash. */
const normalise = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

const RouteContext = createContext('/')

export const useRoute = () => useContext(RouteContext)

export function navigate(to: string) {
  const target = normalise(to)
  if (target === normalise(window.location.pathname)) return
  window.history.pushState(null, '', to)
  // pushState fires no event of its own; the listener below is what re-renders.
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => normalise(window.location.pathname))

  useEffect(() => {
    const onPopState = () => setPath(normalise(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return <RouteContext.Provider value={path}>{children}</RouteContext.Provider>
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
