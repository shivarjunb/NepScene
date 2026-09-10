import { useEffect, useMemo, useState } from 'react'
import type { Bootstrap, Listing } from '../lib/catalog'
import { fetchBootstrap, fetchListings } from '../lib/client'
import { buildRows, entryCategories } from '../lib/rows'
import { ListingCard, ListingCardSkeleton } from '../components/ListingCard'
import { ListingRail, ListingRailSkeleton } from '../components/ListingRail'
import { Alert } from '../components/primitives'
import { NepalMap } from '../map/NepalMap'
import { Link, navigate, useSearch } from '../router'

/**
 * The discovery feed (#41).
 *
 * Harvested from WaahTickets' PublicApp.tsx in pieces rather than ported: that
 * file is 4,545 lines holding storefront state, the basket, the purchase flow,
 * auth modals, search and rails at once — the monolith NepScene exists to
 * escape. What is worth keeping is the shape of the page —
 * category entry points over rule-based rows — and nothing else came with it.
 *
 * One request paints the first screen (`/api/catalog/bootstrap`), and a filter
 * costs one more. There is no waterfall: nothing here fetches something whose
 * URL depends on a previous response.
 */
export function Discover() {
  const search = useSearch()
  const category = search.get('category') ?? undefined
  const city = search.get('city') ?? undefined
  const filtered = Boolean(category || city)

  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [results, setResults] = useState<Listing[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchBootstrap(controller.signal)
      .then(setBootstrap)
      .catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!filtered) { setResults(null); return }
    const controller = new AbortController()
    setResults(null)
    fetchListings({ category, city, limit: '50' }, controller.signal)
      .then((page) => setResults(page.data))
      .catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message) })
    return () => controller.abort()
  }, [category, city, filtered])

  // `now` is fixed for the life of the render, so a row cannot disagree with
  // the row above it about what "this weekend" means.
  const rows = useMemo(
    () => (bootstrap ? buildRows(bootstrap, new Date()) : []),
    [bootstrap],
  )
  const categories = bootstrap ? entryCategories(bootstrap.categories) : []
  const activeCategory = categories.find((entry) => entry.slug === category)

  if (error) {
    return (
      <div className="layout stack">
        {/* The heading stays. Losing it because a fetch failed leaves a screen
            reader on a page with no identity at all. */}
        <h1 className="hero__title">What’s happening around Nepal</h1>
        <Alert tone="danger" title="The catalogue did not load">
          {error} — <Link href="/">try again</Link>.
        </Alert>
      </div>
    )
  }

  return (
    <div className="layout discover">
      <Hero />

      <nav className="chips" aria-label="Browse by category">
        <Chip href="/" active={!filtered}>Everything</Chip>
        {categories.map((entry) => (
          <Chip
            key={entry.slug}
            href={`/?category=${encodeURIComponent(entry.slug)}`}
            active={entry.slug === category}
            color={entry.color}
          >
            {entry.name}
            <span className="chips__count"> {entry.upcoming_listing_count}</span>
          </Chip>
        ))}
      </nav>

      {filtered
        ? <Results
            heading={activeCategory?.name ?? (city ? `In ${city}` : 'Results')}
            listings={results}
          />
        : <Rows rows={rows} loading={!bootstrap} />}
    </div>
  )
}

/**
 * The hero map — #41's first scope item, unblocked now the map core (#36) is
 * in. The slot held a labelled placeholder while that was outstanding.
 *
 * It mounts the same `NepalMap` the /map page does rather than a cut-down
 * copy for the hero. The map owns its viewport fetching, its empty states and
 * its own failure, so what is left for the hero is the frame around it and
 * where a popup sends the reader — which is the whole reason that component
 * takes `onOpen` instead of routing itself.
 */
function Hero() {
  return (
    <section className="hero">
      <h1 className="hero__title">What’s happening around Nepal</h1>
      <p className="hero__lead">
        Concerts, festivals, sport, comedy and community events — bounded and
        upcoming by default.
      </p>
      <div className="hero__map">
        <NepalMap onOpen={(slug) => navigate(`/listings/${slug}`)} />
      </div>
    </section>
  )
}

function Chip({ href, active, color, children }: {
  href: string
  active: boolean
  color?: string | null
  children: React.ReactNode
}) {
  return (
    <Link
      className="chips__chip"
      href={href}
      aria-current={active ? 'true' : undefined}
      style={color ? { ['--chip-accent' as string]: color } : undefined}
      onClick={(event) => {
        // Replace rather than push: twelve categories clicked in a row should
        // not be twelve presses of Back to get out of the page.
        event.preventDefault()
        navigate(href, { replace: true })
      }}
    >
      {children}
    </Link>
  )
}

function Rows({ rows, loading }: { rows: ReturnType<typeof buildRows>; loading: boolean }) {
  if (loading) {
    return (
      <div className="discover__rows">
        {[0, 1, 2].map((index) => <ListingRailSkeleton key={index} />)}
      </div>
    )
  }

  const anything = rows.some((row) => row.listings.length > 0)
  if (!anything) {
    return (
      <Alert tone="info" title="Nothing on yet">
        The catalogue has no upcoming listings. Rows appear here as soon as
        something is published.
      </Alert>
    )
  }

  return (
    <div className="discover__rows">
      {rows.map((row) => <ListingRail key={row.id} row={row} />)}
    </div>
  )
}

function Results({ heading, listings }: { heading: string; listings: Listing[] | null }) {
  return (
    <section className="results" aria-labelledby="results-heading">
      <h2 id="results-heading" className="results__heading">
        {heading}
        {listings && <span className="results__count"> · {listings.length}</span>}
      </h2>

      {listings === null ? (
        <div className="grid">
          {[0, 1, 2, 3, 4, 5].map((index) => <ListingCardSkeleton key={index} />)}
        </div>
      ) : listings.length === 0 ? (
        <p className="rail__empty">
          Nothing coming up here yet. <Link href="/">See everything</Link>.
        </p>
      ) : (
        <ul className="grid" role="list">
          {listings.map((listing) => (
            <li key={listing.id}><ListingCard listing={listing} /></li>
          ))}
        </ul>
      )}
    </section>
  )
}
