import type { Env } from '../env'
import { ApiError } from '../lib/http'
import {
  MovedPermanently, loadArtist, loadHome, loadListing, loadOrganizer, loadOrganizers,
  loadVenue, loadVenues, type PageData,
} from './data'
import { robots, sitemapIndex, sitemapSegment } from './sitemap'

/**
 * Which URLs the Worker renders, and which it leaves to the static asset (#45).
 *
 * **Only the pages a search engine should land on.** Server rendering costs a
 * D1 round trip and an isolate's CPU per request; the wizard, the dashboard and
 * the moderation queue need a session, are `noindex` by nature, and get nothing
 * from it. They fall through to the SPA exactly as before.
 *
 * `/search` *is* rendered — a reader arriving without JavaScript should still
 * see results — but it is served `noindex`, so the rendering is for people and
 * not for crawlers.
 */
type Match = {
  load: (env: Env) => Promise<PageData>
}

const PREFIXES: { prefix: string; load: (env: Env, slug: string) => Promise<PageData> }[] = [
  { prefix: '/listings/', load: loadListing },
  { prefix: '/venues/', load: loadVenue },
  { prefix: '/organizers/', load: loadOrganizer },
  { prefix: '/artists/', load: loadArtist },
]

export function matchRenderRoute(pathname: string): Match | null {
  if (pathname === '/') return { load: loadHome }
  if (pathname === '/venues') return { load: loadVenues }
  if (pathname === '/organizers') return { load: loadOrganizers }
  if (pathname === '/search') {
    // Nothing is loaded: search reads the query string, and rendering it on
    // the server would mean running a ranked search per crawl of a page that
    // is not indexed. The shell renders, the client fetches.
    return { load: async () => ({ preload: {}, subject: { kind: 'search', query: '' } }) }
  }

  for (const route of PREFIXES) {
    if (!pathname.startsWith(route.prefix)) continue
    const slug = pathname.slice(route.prefix.length)
    if (!slug || slug.includes('/')) continue
    let decoded: string
    try {
      decoded = decodeURIComponent(slug)
    } catch {
      // A malformed escape is not a slug we have. Let the SPA render its own
      // not-found page rather than answering 500 from here.
      return null
    }
    return { load: (env) => route.load(env, decoded) }
  }
  return null
}

export type SeoResponse = { response: Response } | null

/**
 * The non-HTML SEO endpoints. Handled before the page routes because
 * `/sitemap.xml` is not a page and must never be rewritten as one.
 */
export async function handleSeoRoute(env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === '/robots.txt') return robots(env, url.origin)
  if (url.pathname === '/sitemap.xml') return sitemapIndex(env, url.origin)

  const segment = /^\/sitemaps\/([a-z0-9-]+)\.xml$/.exec(url.pathname)
  if (segment) {
    return (await sitemapSegment(env, url.origin, segment[1] as string))
      ?? new Response('No such sitemap', { status: 404 })
  }
  return null
}

export { MovedPermanently, ApiError }
