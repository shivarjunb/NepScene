import { renderApp } from '#ssr'
import type { Env } from '../env'
// DOM-free by construction — it touches `globalThis` and `JSON` and nothing
// else — so the Worker imports it directly rather than through `#ssr`. It is
// the *contract* for the preloaded data, and both sides must read the same one.
import { PRELOAD_GLOBAL, serialisePreloaded } from '../../app/lib/preload'
import type { Metadata } from './metadata'
import {
  artistMetadata, homeMetadata, indexMetadata, listingMetadata, organizerMetadata,
  searchMetadata, venueMetadata,
} from './metadata'
import {
  artistPageOf, breadcrumbsOf, eventOf, organizerPageOf, serialiseJsonLd, venuePageOf, websiteOf,
} from './structured'
import type { PageData } from './data'

/**
 * A page, rendered (#45).
 *
 * **The shell is the built `index.html`, not a template in here.** Vite writes
 * the hashed script and stylesheet names into it, along with the inline theme
 * script that has to run before first paint (#17). Rebuilding that document in
 * the Worker would mean a second copy of it going stale every time the build
 * output changes — so the asset is fetched and rewritten instead, with
 * `HTMLRewriter`, which is streaming and does not parse the document into a
 * string to do it.
 *
 * What gets rewritten is exactly what is per-page: the title, the description,
 * the social card, the canonical and language alternates, the structured data,
 * and the contents of `#root`.
 */
export type Rendered = {
  html: Response
  metadata: Metadata
}

const CACHE_SECONDS = 60

export async function renderPage(
  env: Env, request: Request, data: PageData, language: 'en' | 'ne',
): Promise<Response> {
  const url = new URL(request.url)
  const origin = url.origin
  const metadata = metadataFor(data, origin, language)
  const jsonLd = structuredDataFor(data, origin)

  // The same table the browser uses, so the tab title before hydration and
  // after it are the same string.
  const documentTitle = metadata.title

  const markup = renderApp(
    { path: url.pathname.replace(/(.)\/+$/, '$1'), search: url.search },
    language,
    data.preload,
  )

  const shell = await env.ASSETS.fetch(new Request(new URL('/index.html', url), { method: 'GET' }))
  if (!shell.ok) {
    // No shell means no build. Falling through to the asset handler gives the
    // reader whatever it would have given them, rather than a 500 from here.
    return shell
  }

  const head = [
    `<link rel="canonical" href="${escapeAttribute(metadata.canonical)}">`,
    ...metadata.alternates.map((alternate) =>
      `<link rel="alternate" hreflang="${escapeAttribute(alternate.hreflang)}"`
      + ` href="${escapeAttribute(alternate.href)}">`),
    metadata.noindex ? '<meta name="robots" content="noindex, follow">' : '',
    jsonLd.length > 0
      ? `<script type="application/ld+json">${serialiseJsonLd(jsonLd)}</script>`
      : '',
  ].filter(Boolean).join('')

  const preload = Object.keys(data.preload).length > 0
    ? `<script>globalThis.${PRELOAD_GLOBAL}=${serialisePreloaded(data.preload)}</script>`
    : ''

  const response = new HTMLRewriter()
    .on('html', {
      element(element) {
        // The document's language, which is what a screen reader reads it in
        // and what a search engine files it under (#46).
        element.setAttribute('lang', language)
      },
    })
    .on('title', {
      element(element) { element.setInnerContent(documentTitle) },
    })
    .on('meta[name="description"]', {
      element(element) { element.setAttribute('content', metadata.description) },
    })
    .on('meta[property="og:url"]', {
      element(element) { element.setAttribute('content', metadata.canonical) },
    })
    .on('meta[property="og:title"]', {
      element(element) { element.setAttribute('content', documentTitle) },
    })
    .on('meta[property="og:description"]', {
      element(element) { element.setAttribute('content', metadata.description) },
    })
    .on('meta[property="og:image"]', {
      element(element) { element.setAttribute('content', metadata.image) },
    })
    .on('meta[property="og:image:alt"]', {
      element(element) { element.setAttribute('content', metadata.imageAlt) },
    })
    .on('meta[property="og:type"]', {
      element(element) { element.setAttribute('content', metadata.ogType) },
    })
    .on('head', {
      element(element) { element.append(head, { html: true }) },
    })
    .on('#root', {
      element(element) {
        // The marker is what tells the client to hydrate rather than mount
        // (app/main.tsx), and the language is what it hydrates *as*.
        element.setAttribute('data-rendered', 'server')
        element.setAttribute('data-language', language)
        element.setInnerContent(markup, { html: true })
        element.after(preload, { html: true })
      },
    })
    .transform(shell)

  const headers = new Headers(response.headers)
  headers.set('content-type', 'text/html; charset=utf-8')
  // Short, and public: a listing page is the same for everybody, and the
  // language variant is a different URL (`?lang=ne`), so `Vary` is not needed
  // to keep the two apart.
  headers.set('cache-control', `public, max-age=0, s-maxage=${CACHE_SECONDS}`)
  return new Response(response.body, { status: 200, headers })
}

/** Which language this request asked for. Default English — every listing has one. */
export function languageOf(url: URL): 'en' | 'ne' {
  return url.searchParams.get('lang') === 'ne' ? 'ne' : 'en'
}

function metadataFor(data: PageData, origin: string, language: 'en' | 'ne'): Metadata {
  const subject = data.subject
  switch (subject.kind) {
    case 'listing': return listingMetadata(subject.listing, origin, language)
    case 'venue': return venueMetadata(subject.venue, origin)
    case 'organizer': return organizerMetadata(subject.organizer, origin)
    case 'artist': return artistMetadata(subject.artist, origin)
    case 'venues': return indexMetadata('venues', origin)
    case 'organizers': return indexMetadata('organizers', origin)
    case 'search': return searchMetadata(subject.query, origin)
    default: return homeMetadata(origin)
  }
}

function structuredDataFor(data: PageData, origin: string): Record<string, unknown>[] {
  const subject = data.subject
  switch (subject.kind) {
    case 'listing':
      return [
        eventOf(subject.listing, origin),
        breadcrumbsOf([
          { name: 'NepScene', path: '/' },
          ...(subject.listing.venue
            ? [{ name: subject.listing.venue.name, path: `/venues/${subject.listing.venue.slug}` }]
            : []),
          { name: subject.listing.title, path: `/listings/${subject.listing.slug}` },
        ], origin),
      ]
    case 'venue':
      return [
        venuePageOf(subject.venue, subject.listings, origin),
        breadcrumbsOf([
          { name: 'NepScene', path: '/' },
          { name: 'Venues', path: '/venues' },
          { name: subject.venue.name, path: `/venues/${subject.venue.slug}` },
        ], origin),
      ]
    case 'organizer':
      return [organizerPageOf(subject.organizer, subject.listings, origin)]
    case 'artist':
      return [artistPageOf(subject.artist, subject.listings, origin)]
    case 'home':
      return [websiteOf(origin)]
    default:
      // A browse surface describes nothing in particular, and structured data
      // that describes nothing is data a validator objects to.
      return []
  }
}

/** Attribute values go into markup we build by hand; the rest is HTMLRewriter's. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
