import { useEffect, useMemo, useState } from 'react'
import type { Listing } from '../lib/catalog'
import { fetchBootstrap, fetchListings } from '../lib/client'
import { useResource } from '../lib/useResource'
import { buildRows, entryCategories } from '../lib/rows'
import { ListingCard, ListingCardSkeleton } from '../components/ListingCard'
import { ListingRail, ListingRailSkeleton } from '../components/ListingRail'
import { SearchBox } from '../components/SearchBox'
import { Alert } from '../components/primitives'
import { NepalMap } from '../map/NepalMap'
import { useLocation } from '../map/useLocation'
import { useLanguage, useT } from '../i18n'
import { categoryName, count } from '../lib/format'
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
  const t = useT()
  const { language } = useLanguage()
  const search = useSearch()
  const category = search.get('category') ?? undefined
  const city = search.get('city') ?? undefined
  const filtered = Boolean(category || city)

  // The homepage's first screen, which the server has usually already loaded
  // (#45) — so this seeds from the document rather than fetching again.
  const { data: bootstrap, error: bootstrapError } =
    useResource(fetchBootstrap, [], '/bootstrap')

  const [results, setResults] = useState<Listing[] | null>(null)
  const [error, setError] = useState<string | null>(bootstrapError?.message ?? null)

  useEffect(() => {
    if (bootstrapError) setError(bootstrapError.message)
  }, [bootstrapError])

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
        <h1 className="hero__title">{t('discover.title')}</h1>
        <Alert tone="danger" title={t('discover.loadFailed')}>
          {error} — <Link href="/">{t('discover.tryAgain')}</Link>.
        </Alert>
      </div>
    )
  }

  return (
    <div className="layout discover">
      <Hero />

      <nav className="chips" aria-label={t('discover.browseByCategory')}>
        <Chip href="/" active={!filtered}>{t('discover.everything')}</Chip>
        {categories.map((entry) => (
          <Chip
            key={entry.slug}
            href={`/?category=${encodeURIComponent(entry.slug)}`}
            active={entry.slug === category}
            color={entry.color}
          >
            {categoryName(entry, language)}
            <span className="chips__count"> {count(entry.upcoming_listing_count, language)}</span>
          </Chip>
        ))}
      </nav>

      {filtered
        ? <Results
            heading={(activeCategory && categoryName(activeCategory, language))
              ?? (city ? t('discover.inCity', { city }) : t('discover.results'))}
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
  const t = useT()
  /**
   * Resolved here rather than inside the map (#38), so the headline and the
   * map are two views of one answer. Two `useLocation()` calls would be two
   * `/here` requests that could disagree, and a headline naming a city the
   * map is not centred on is worse than a headline naming no city at all.
   */
  const location = useLocation()

  return (
    <section className="hero">
      {/* Keyed on the city so React replaces the node rather than patching
          its text — which is what gives the reveal something to animate. The
          animation itself is CSS and is suppressed under reduced motion. */}
      <h1 className="hero__title" key={location.city}>
        <span className="hero__title-reveal">
          {t('discover.titleIn', { city: location.city })}
        </span>
      </h1>
      <p className="hero__lead">{t('discover.lead')}</p>
      {/* Search sits under the hero on every screen, not only in the header
          where the phone layout hides it (#42). */}
      <div className="hero__search">
        <SearchBox />
      </div>
      <div className="hero__map">
        <NepalMap location={location} onOpen={(slug) => navigate(`/listings/${slug}`)} />
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
  const t = useT()
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
      <Alert tone="info" title={t('discover.nothingYet')}>
        {t('discover.nothingYetBody')}
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
  const t = useT()
  const { language } = useLanguage()
  return (
    <section className="results" aria-labelledby="results-heading">
      <h2 id="results-heading" className="results__heading">
        {heading}
        {listings && <span className="results__count"> · {count(listings.length, language)}</span>}
      </h2>

      {listings === null ? (
        <div className="grid">
          {[0, 1, 2, 3, 4, 5].map((index) => <ListingCardSkeleton key={index} />)}
        </div>
      ) : listings.length === 0 ? (
        <p className="rail__empty">
          {t('discover.nothingHere')} <Link href="/">{t('discover.seeEverything')}</Link>.
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
