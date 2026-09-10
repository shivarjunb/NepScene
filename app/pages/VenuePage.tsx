import { fetchVenue } from '../lib/client'
import { useResource } from '../lib/useResource'
import { directionsUrl } from '../lib/share'
import { count } from '../lib/format'
import { useLanguage, useT } from '../i18n'
import { StaticMap } from '../components/StaticMap'
import { Alert } from '../components/primitives'
import { PlaceHeader, PlacePage, PlaceMissing, PlaceSkeleton } from './PlaceLayout'

/**
 * A venue's own page (#44).
 *
 * These pages do disproportionate search work: people look up "what's on at
 * Patan Durbar Square" far more often than they look up an event they have
 * never heard of, and that query currently has nowhere to land.
 */
export function VenuePage({ slug }: { slug: string }) {
  const t = useT()
  const { language } = useLanguage()
  const { data, loading, missing, error } = useResource(
    (signal) => fetchVenue(slug, signal), [slug],
  )

  if (loading) return <PlaceSkeleton />
  if (missing) {
    return (
      <PlaceMissing
        title={t('venues.title')}
        body={t('place.nothingAtAll')}
        backHref="/venues"
        backLabel={t('venues.title')}
      />
    )
  }
  if (error || !data) {
    return (
      <div className="layout stack">
        <h1>{t('common.error')}</h1>
        <Alert tone="danger" title={t('common.error')}>{error?.message}</Alert>
      </div>
    )
  }

  const { venue } = data
  const place = [venue.area, venue.city, venue.district].filter(Boolean).join(', ')

  return (
    <PlacePage
      pastHeading="here"
      upcoming={data.listings}
      past={data.past}
      header={
        <PlaceHeader
          name={venue.name}
          kind={t('venues.title')}
          description={venue.description}
          counts={{ upcoming: venue.upcoming_listing_count, past: venue.past_listing_count }}
          meta={
            <div className="place-header__meta">
              {place && <p className="text-muted">{place}</p>}
              {venue.address && <p className="text-muted">{venue.address}</p>}
              <ul className="place-header__facts" role="list">
                {venue.capacity && (
                  <li>{t('place.capacity', { count: count(venue.capacity, language) })}</li>
                )}
                {venue.website_url && (
                  <li>
                    <a href={venue.website_url} target="_blank" rel="noopener noreferrer">
                      {t('place.website')}
                    </a>
                  </li>
                )}
                {/* A phone number is a link on the device where tapping it is
                    the point, and plain text everywhere else — `tel:` does
                    both without a user-agent check. */}
                {venue.phone && <li><a href={`tel:${venue.phone}`}>{venue.phone}</a></li>}
              </ul>
              <StaticMap
                latitude={venue.latitude}
                longitude={venue.longitude}
                label={venue.name}
              />
            </div>
          }
        >
          <a
            className="btn btn--primary btn--sm"
            href={directionsUrl(venue)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('listing.directions')}
          </a>
        </PlaceHeader>
      }
    />
  )
}
