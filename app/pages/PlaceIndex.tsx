import { useState } from 'react'
import type { OrganizerSummary, VenueSummary } from '../lib/catalog'
import { fetchOrganizers, fetchVenues } from '../lib/client'
import { useResource } from '../lib/useResource'
import { count } from '../lib/format'
import { useLanguage, useT } from '../i18n'
import { Alert, Input, Skeleton } from '../components/primitives'
import { Link } from '../router'

/**
 * The two index pages (#44): every venue, and every organizer with something
 * published.
 *
 * The filter is client-side over a page the server bounded, not a second
 * search: this is a browse surface for a few hundred rows, and typing here is
 * "find the one I already know the name of". Real search — ranked, tolerant of
 * spelling, across the whole catalogue — is `/search`, and the empty state
 * says so rather than leaving the reader with nothing.
 */
export function VenuesIndex() {
  const t = useT()
  const { data, loading, error } = useResource(
    (signal) => fetchVenues({ limit: '50' }, signal), [],
  )
  return (
    <Index
      title={t('venues.title')}
      lead={t('venues.lead')}
      placeholder={t('venues.searchPlaceholder')}
      loading={loading}
      error={error}
      rows={(data?.data ?? []).map(venueRow)}
    />
  )
}

export function OrganizersIndex() {
  const t = useT()
  const { data, loading, error } = useResource(
    (signal) => fetchOrganizers({ limit: '50' }, signal), [],
  )
  return (
    <Index
      title={t('organizers.title')}
      lead={t('organizers.lead')}
      placeholder={t('organizers.searchPlaceholder')}
      loading={loading}
      error={error}
      rows={(data?.data ?? []).map(organizerRow)}
    />
  )
}

type Row = {
  slug: string
  href: string
  name: string
  detail: string | null
  upcoming: number
  /** Everything a reader might type to find this row. */
  haystack: string
}

const venueRow = (venue: VenueSummary): Row => ({
  slug: venue.slug,
  href: `/venues/${venue.slug}`,
  name: venue.name,
  detail: [venue.area, venue.city].filter(Boolean).join(', ') || null,
  upcoming: venue.upcoming_listing_count,
  haystack: [venue.name, venue.area, venue.city, venue.district].filter(Boolean).join(' ').toLowerCase(),
})

const organizerRow = (organizer: OrganizerSummary): Row => ({
  slug: organizer.slug,
  href: `/organizers/${organizer.slug}`,
  name: organizer.name,
  detail: organizer.description,
  upcoming: organizer.upcoming_listing_count,
  haystack: organizer.name.toLowerCase(),
})

function Index({ title, lead, placeholder, rows, loading, error }: {
  title: string
  lead: string
  placeholder: string
  rows: Row[]
  loading: boolean
  error: Error | null
}) {
  const t = useT()
  const { language } = useLanguage()
  const [filter, setFilter] = useState('')

  const needle = filter.trim().toLowerCase()
  const visible = needle ? rows.filter((row) => row.haystack.includes(needle)) : rows

  return (
    <div className="layout stack">
      <header className="stack stack--tight">
        <h1>{title}</h1>
        <p className="text-muted">{lead}</p>
      </header>

      <label className="place-index__filter">
        <span className="visually-hidden">{placeholder}</span>
        <Input
          type="search"
          placeholder={placeholder}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>

      {error && <Alert tone="danger" title={t('common.error')}>{error.message}</Alert>}

      {loading ? (
        <ul className="place-index" role="list">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <li key={index} className="place-index__row"><Skeleton height="3rem" /></li>
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <p className="rail__empty">
          {t('discover.nothingHere')}{' '}
          <Link href={`/search?q=${encodeURIComponent(filter)}`}>{t('search.submit')}</Link>
        </p>
      ) : (
        <ul className="place-index" role="list">
          {visible.map((row) => (
            <li key={row.slug} className="place-index__row">
              <Link className="place-index__link" href={row.href}>
                <span className="place-index__name">{row.name}</span>
                {row.detail && <span className="place-index__detail">{row.detail}</span>}
              </Link>
              <span className="place-index__count">
                {t('place.count.upcoming', { count: count(row.upcoming, language) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
