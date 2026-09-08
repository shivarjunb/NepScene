import type { ReactNode } from 'react'
import { Placeholder, type Planned } from './pages/Placeholder'
import { NotFound } from './pages/NotFound'
import { DesignSystem } from './pages/DesignSystem'
import { Discover } from './pages/Discover'

/**
 * Every path the shell links to, in one table.
 *
 * The rule while the site is being built: if the header or the footer links to
 * it, it has a row here. A link with no row is the bug this table exists to
 * make impossible — that is how /organizers came to serve the design system.
 */
type Route = Planned & { path: string; element?: ReactNode }

export const ROUTES: Route[] = [
  {
    path: '/',
    title: 'Discover',
    summary: 'What is on around Nepal — bounded and upcoming by default, near you when you allow it.',
    element: <Discover />,
  },
  {
    path: '/map',
    title: 'Map',
    summary: 'Every listing on one map, grouped by venue, filtered by distance and date.',
    issue: 37,
    milestone: 'M3 — Map discovery',
  },
  {
    path: '/venues',
    title: 'Venues',
    summary: 'Places that host things, and what is coming up at each.',
    issue: 44,
    milestone: 'M4 — Public site',
  },
  {
    path: '/organizers',
    title: 'Organizers',
    summary: 'Who puts events on, and everything they have listed.',
    issue: 44,
    milestone: 'M4 — Public site',
  },
  {
    path: '/submit',
    title: 'Submit an event',
    summary: 'The listing wizard: what, where, when, and a picture.',
    issue: 30,
    milestone: 'M2 — Event authoring',
  },
  {
    path: '/about',
    title: 'About NepScene',
    summary: 'What this is, who runs it, and how listings get here.',
  },
  {
    path: '/privacy',
    title: 'Privacy',
    summary: 'What NepScene stores, why, and for how long.',
  },
  {
    path: '/design-system',
    title: 'Design system',
    summary: 'Every token and every component in every state.',
    element: <DesignSystem />,
  },
]

export function routeFor(path: string) {
  return ROUTES.find((route) => route.path === path)
}

/**
 * One dynamic route, matched by prefix. The cards have to link somewhere real —
 * a card that goes nowhere teaches people the feed is decorative — so a listing
 * URL resolves to the page that will hold it. The slug is not read yet; #43 is
 * what turns this into a listing.
 */
const LISTING_PREFIX = '/listings/'

export function renderRoute(path: string): ReactNode {
  const route = routeFor(path)
  if (route) return route.element ?? <Placeholder {...route} />

  if (path.startsWith(LISTING_PREFIX) && path.length > LISTING_PREFIX.length) {
    return (
      <Placeholder
        title="Listing"
        summary="The full listing: description, media, artists, the venue on a map, and the offer if it carries one."
        issue={43}
        milestone="M4 — Public site"
      />
    )
  }

  return <NotFound path={path} />
}

/** The tab title is the only thing that tells a user which page they are on. */
export function titleFor(path: string) {
  const route = routeFor(path)
  if (!route) {
    return path.startsWith(LISTING_PREFIX) && path.length > LISTING_PREFIX.length
      ? 'Listing — NepScene'
      : 'Page not found — NepScene'
  }
  return route.path === '/'
    ? "NepScene — what's happening around Nepal"
    : `${route.title} — NepScene`
}
