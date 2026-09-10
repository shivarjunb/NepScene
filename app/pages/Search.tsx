import { useState } from 'react'
import type { Facet, Listing, SearchFacets, Suggestion } from '../lib/catalog'
import { fetchSearch } from '../lib/client'
import { useResource } from '../lib/useResource'
import { count } from '../lib/format'
import { useLanguage, useT } from '../i18n'
import { Alert, Button } from '../components/primitives'
import { ListingCard, ListingCardSkeleton } from '../components/ListingCard'
import { SearchBox } from '../components/SearchBox'
import { Link, navigate, useSearch } from '../router'

/**
 * The search page (#42).
 *
 * **The query string is the state.** Every filter is a URL parameter, so a
 * refined search can be linked, shared, reloaded and reached with Back —
 * WaahTickets kept its filters in React state and every filtered page was the
 * homepage again when you sent it to someone.
 *
 * **Facets are counts the server took, not counts this page derived.** They
 * describe the whole matching set, so the number on a chip is what the reader
 * gets after clicking it, even when the results in front of them are page one
 * of five.
 */

/** Which URL parameters are filters, in the order they are shown. */
const FACET_PARAM = {
  city: 'city',
  category: 'category',
  price: 'price',
  when: 'when',
} as const

type FacetName = keyof typeof FACET_PARAM

export function SearchPage() {
  const t = useT()
  const { language } = useLanguage()
  const params = useSearch()
  const query = params.get('q') ?? ''

  // Serialised so the effect re-runs on any filter change without listing
  // eight parameters — the URL *is* the request.
  const search = params.toString()
  const { data, loading, error } = useResource(
    (signal) => fetchSearch(Object.fromEntries(new URLSearchParams(search)), signal),
    [search],
  )

  const active = activeFilters(params)
  const heading = query
    ? t('search.resultsFor', { query })
    : active.length > 0 ? t('discover.results') : t('search.everything')

  return (
    <div className="layout stack search-page">
      <header className="stack stack--tight">
        <h1>{t('search.title')}</h1>
        <SearchBox initial={query} autoFocus={!query} />
      </header>

      {error && <Alert tone="danger" title={t('common.error')}>{error.message}</Alert>}

      {data?.corrected_from && (
        <Alert tone="info">
          {t('search.correctedFrom', { query: data.corrected_from })}{' '}
          <Link href={`/search?q=${encodeURIComponent(data.corrected_from)}&exact=1`}>
            {t('search.searchInstead', { query: data.corrected_from })}
          </Link>
        </Alert>
      )}

      <div className="search-page__body">
        <Facets facets={data?.facets ?? null} params={params} />

        <section className="search-page__results" aria-labelledby="results-heading">
          <div className="search-page__results-head">
            <h2 id="results-heading">{heading}</h2>
            {data && (
              <p className="text-muted">
                {/* The total, not the page. The date facets partition the whole
                    matching set and are mutually exclusive, so they sum to it —
                    which is the only number the API returns that is a count of
                    everything rather than of what fitted on this page. */}
                {t('search.counted', { count: count(totalOf(data.facets), language) })}
              </p>
            )}
          </div>

          {active.length > 0 && (
            <ul className="chips chips--active" role="list">
              {active.map((filter) => (
                <li key={filter.key}>
                  <button
                    type="button"
                    className="chips__chip chips__chip--removable"
                    onClick={() => navigate(withoutParam(params, filter.key), { replace: true })}
                  >
                    {filter.label}
                    <span aria-hidden="true"> ✕</span>
                    <span className="visually-hidden"> — {t('search.clearFilters')}</span>
                  </button>
                </li>
              ))}
              <li>
                <Link className="chips__chip" href={query ? `/search?q=${encodeURIComponent(query)}` : '/search'}>
                  {t('search.clearFilters')}
                </Link>
              </li>
            </ul>
          )}

          {loading ? (
            <ul className="grid" role="list">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <li key={index}><ListingCardSkeleton /></li>
              ))}
            </ul>
          ) : data && data.data.length > 0 ? (
            <Results
              page={data.data}
              nextCursor={data.page.next_cursor}
              params={params}
            />
          ) : (
            <NoResults query={query} alternatives={data?.alternatives ?? []} />
          )}
        </section>
      </div>
    </div>
  )
}

const totalOf = (facets: SearchFacets) =>
  facets.when.reduce((sum, facet) => sum + facet.count, 0)

function Results({ page, nextCursor, params }: {
  page: Listing[]
  /** Opaque, and issued by the server — the page cannot construct one. */
  nextCursor: string | null
  params: URLSearchParams
}) {
  const t = useT()
  return (
    <>
      <ul className="grid" role="list">
        {page.map((listing) => (
          <li key={listing.id}><ListingCard listing={listing} /></li>
        ))}
      </ul>
      {nextCursor && (
        <p className="search-page__more">
          {/* A link rather than infinite scroll: a ranked page reached by
              cursor is a real address, so the reader can go back to it and
              send it to somebody. */}
          <Link
            className="btn btn--secondary"
            href={`/search?${withParam(params, 'cursor', nextCursor)}`}
          >
            {t('search.more')}
          </Link>
        </p>
      )}
    </>
  )
}

function NoResults({ query, alternatives }: { query: string; alternatives: Suggestion[] }) {
  const t = useT()
  return (
    <div className="stack search-page__empty">
      <Alert tone="info" title={query ? t('search.noResults', { query }) : t('discover.nothingYet')}>
        {t('search.noResultsBody')}
      </Alert>
      {alternatives.length > 0 && (
        <ul className="chips" role="list">
          {alternatives.map((alternative) => (
            <li key={`${alternative.kind}:${alternative.slug}`}>
              <Link className="chips__chip" href={hrefFor(alternative)}>{alternative.label}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const hrefFor = (suggestion: Suggestion): string => {
  switch (suggestion.kind) {
    case 'listing': return `/listings/${suggestion.slug}`
    case 'venue': return `/venues/${suggestion.slug}`
    case 'organizer': return `/organizers/${suggestion.slug}`
    case 'artist': return `/artists/${suggestion.slug}`
    case 'category': return `/search?category=${encodeURIComponent(suggestion.slug)}`
    case 'tag': return `/search?tag=${encodeURIComponent(suggestion.slug)}`
    default: return `/search?q=${encodeURIComponent(suggestion.label)}`
  }
}

function Facets({ facets, params }: { facets: SearchFacets | null; params: URLSearchParams }) {
  const t = useT()
  const { language } = useLanguage()
  const [open, setOpen] = useState(false)

  if (!facets) return null

  const groups = ([
    { name: 'when', label: t('search.facet.when'), entries: facets.when },
    { name: 'category', label: t('search.facet.category'), entries: facets.category },
    { name: 'city', label: t('search.facet.city'), entries: facets.city },
    { name: 'price', label: t('search.facet.price'), entries: facets.price },
  ] satisfies { name: FacetName; label: string; entries: Facet[] }[])
    // A group with one option is not a filter, it is a fact about the results.
    .filter((group) => group.entries.length > 1)

  if (groups.length === 0) return null

  return (
    <aside className={`facets ${open ? 'facets--open' : ''}`} aria-label={t('search.filters')}>
      {/* On a phone the filters are behind a disclosure; from 60rem up the
          panel is always there and the button is not rendered at all. */}
      <Button
        variant="secondary"
        size="sm"
        className="facets__toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {t('search.filters')}
      </Button>

      <div className="facets__panel" hidden={!open}>
        {groups.map((group) => (
          <fieldset key={group.name} className="facets__group">
            <legend className="facets__legend">{group.label}</legend>
            <ul className="chips" role="list">
              {group.entries.map((entry) => {
                const selected = isSelected(params, group.name, entry)
                return (
                  <li key={entry.value}>
                    <Link
                      className="chips__chip"
                      href={toggleFacet(params, group.name, entry, selected)}
                      aria-current={selected ? 'true' : undefined}
                    >
                      {language === 'ne' && entry.label_ne ? entry.label_ne : entry.label}
                      <span className="chips__count"> {count(entry.count, language)}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </fieldset>
        ))}
      </div>
    </aside>
  )
}

/**
 * A date facet is a window, not a value: it applies as `from`/`to`, the same
 * bounds the count was taken over, so the chip that says 8 leads to 8. The
 * other three are plain equality filters.
 */
function toggleFacet(
  params: URLSearchParams, name: FacetName, entry: Facet, selected: boolean,
): string {
  const next = new URLSearchParams(params)
  // Any change to a filter invalidates the page position.
  next.delete('cursor')

  if (name === 'when') {
    next.delete('when')
    next.delete('from')
    next.delete('to')
    if (!selected) {
      next.set('when', entry.value)
      if (entry.from) next.set('from', entry.from)
      if (entry.to) next.set('to', entry.to)
    }
  } else if (selected) {
    next.delete(FACET_PARAM[name])
  } else {
    next.set(FACET_PARAM[name], entry.value)
  }
  return `/search?${next}`
}

const isSelected = (params: URLSearchParams, name: FacetName, entry: Facet) =>
  name === 'when'
    ? params.get('when') === entry.value
    : (params.get(FACET_PARAM[name]) ?? '').toLowerCase() === entry.value.toLowerCase()

function withoutParam(params: URLSearchParams, key: string): string {
  const next = new URLSearchParams(params)
  next.delete(key)
  next.delete('cursor')
  if (key === 'when') { next.delete('from'); next.delete('to') }
  return `/search?${next}`
}

function withParam(params: URLSearchParams, key: string, value: string): string {
  const next = new URLSearchParams(params)
  next.set(key, value)
  return next.toString()
}

/** The filters currently applied, as removable chips. */
function activeFilters(params: URLSearchParams): { key: string; label: string }[] {
  const filters: { key: string; label: string }[] = []
  for (const key of ['city', 'category', 'price', 'tag', 'venue', 'organizer', 'artist', 'when']) {
    const value = params.get(key)
    if (value) filters.push({ key, label: value })
  }
  return filters
}
