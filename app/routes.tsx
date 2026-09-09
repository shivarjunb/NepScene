import type { ReactNode } from 'react'
import { Placeholder, type Planned } from './pages/Placeholder'
import { NotFound } from './pages/NotFound'
import { DesignSystem } from './pages/DesignSystem'
import { Discover } from './pages/Discover'
import { SubmitPage } from './author/SubmitPage'
import { QueuePage } from './moderation/QueuePage'
import { DashboardPage } from './author/DashboardPage'
import { ListingRoute } from './pages/ListingRoute'

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
    element: <SubmitPage listingId={null} />,
  },
  {
    path: '/dashboard',
    title: 'Your listings',
    summary: 'Everything you have listed, what state it is in, and how many people looked.',
    element: <DashboardPage />,
  },
  {
    path: '/moderate',
    title: 'Moderation queue',
    summary: 'Everything waiting for review, oldest first, with the duplicates already flagged.',
    element: <QueuePage />,
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

/**
 * A draft's own address. The wizard rewrites the URL to this the moment
 * autosave first succeeds, so a reload returns to the draft in progress rather
 * than starting a second empty one.
 */
const SUBMIT_PREFIX = '/submit/'

export function renderRoute(path: string): ReactNode {
  const route = routeFor(path)
  if (route) return route.element ?? <Placeholder {...route} />

  if (path.startsWith(SUBMIT_PREFIX) && path.length > SUBMIT_PREFIX.length) {
    return <SubmitPage listingId={path.slice(SUBMIT_PREFIX.length)} />
  }

  if (path.startsWith(LISTING_PREFIX) && path.length > LISTING_PREFIX.length) {
    return (
      <ListingRoute slug={path.slice(LISTING_PREFIX.length)}>
        <Placeholder
          title="Listing"
          summary="The full listing: description, media, artists, the venue on a map, and the offer if it carries one."
          issue={43}
          milestone="M4 — Public site"
        />
      </ListingRoute>
    )
  }

  return <NotFound path={path} />
}

/** The tab title is the only thing that tells a user which page they are on. */
export function titleFor(path: string) {
  const route = routeFor(path)
  if (!route) {
    if (path.startsWith(LISTING_PREFIX) && path.length > LISTING_PREFIX.length) {
      return 'Listing — NepScene'
    }
    if (path.startsWith(SUBMIT_PREFIX) && path.length > SUBMIT_PREFIX.length) {
      return 'Edit your listing — NepScene'
    }
    return 'Page not found — NepScene'
  }
  return route.path === '/'
    ? "NepScene — what's happening around Nepal"
    : `${route.title} — NepScene`
}
