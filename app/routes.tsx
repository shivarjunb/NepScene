import type { ReactNode } from 'react'
import { Placeholder, type Planned } from './pages/Placeholder'
import { NotFound } from './pages/NotFound'
import { DesignSystem } from './pages/DesignSystem'
import { Discover } from './pages/Discover'
import { SubmitPage } from './author/SubmitPage'
import { QueuePage } from './moderation/QueuePage'
import { DashboardPage } from './author/DashboardPage'
import { ListingPage } from './pages/Listing'
import { MapPage } from './pages/MapPage'
import { SearchPage } from './pages/Search'
import { OrganizersIndex, VenuesIndex } from './pages/PlaceIndex'
import { VenuePage } from './pages/VenuePage'
import { OrganizerPage } from './pages/OrganizerPage'
import { ArtistPage } from './pages/ArtistPage'
import { AccessibilityPage } from './pages/Accessibility'

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
    path: '/search',
    title: 'Search',
    summary: 'Everything in the catalogue, ranked, filtered and forgiving of spelling.',
    element: <SearchPage />,
  },
  {
    path: '/map',
    title: 'Map',
    summary: 'Every listing on one map, grouped by venue, filtered by distance and date.',
    element: <MapPage />,
  },
  {
    path: '/venues',
    title: 'Venues',
    summary: 'Places that host things, and what is coming up at each.',
    element: <VenuesIndex />,
  },
  {
    path: '/organizers',
    title: 'Organizers',
    summary: 'Who puts events on, and everything they have listed.',
    element: <OrganizersIndex />,
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
    path: '/accessibility',
    title: 'Accessibility',
    summary: 'What is verified, how, and what is not yet.',
    element: <AccessibilityPage />,
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
 * The dynamic routes, matched by prefix.
 *
 * Each one is `/thing/:slug`, and the slug is the whole parameter — there is
 * no nesting and no optional segment, so a prefix table beats a matcher. The
 * titles below are what the tab says while the page is still loading, which is
 * the only thing that tells a reader with fifteen tabs open which one this is.
 */
const DYNAMIC = [
  { prefix: '/listings/', title: 'Listing', render: (slug: string) => <ListingPage slug={slug} /> },
  { prefix: '/venues/', title: 'Venue', render: (slug: string) => <VenuePage slug={slug} /> },
  { prefix: '/organizers/', title: 'Organizer', render: (slug: string) => <OrganizerPage slug={slug} /> },
  { prefix: '/artists/', title: 'Artist', render: (slug: string) => <ArtistPage slug={slug} /> },
  {
    prefix: '/submit/',
    title: 'Edit your listing',
    // A draft's own address. The wizard rewrites the URL to this the moment
    // autosave first succeeds, so a reload returns to the draft in progress
    // rather than starting a second empty one.
    render: (id: string) => <SubmitPage listingId={id} />,
  },
] as const

function dynamicMatch(path: string) {
  for (const route of DYNAMIC) {
    if (path.startsWith(route.prefix) && path.length > route.prefix.length) {
      return { route, slug: decodeSlug(path.slice(route.prefix.length)) }
    }
  }
  return null
}

/**
 * `decodeURIComponent` throws on a malformed escape — `/listings/%zz` is
 * enough — and this runs during render, so an unguarded call takes the whole
 * app down rather than showing a 404. The raw segment is the honest fallback:
 * it will not match a listing either, and the page that says so still renders.
 */
function decodeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function renderRoute(path: string): ReactNode {
  const route = routeFor(path)
  if (route) return route.element ?? <Placeholder {...route} />

  const dynamic = dynamicMatch(path)
  if (dynamic) return dynamic.route.render(dynamic.slug)

  return <NotFound path={path} />
}

/** The tab title is the only thing that tells a user which page they are on. */
export function titleFor(path: string) {
  const route = routeFor(path)
  if (!route) {
    const dynamic = dynamicMatch(path)
    if (dynamic) return `${dynamic.route.title} — NepScene`
    return 'Page not found — NepScene'
  }
  return route.path === '/'
    ? "NepScene — what's happening around Nepal"
    : `${route.title} — NepScene`
}
