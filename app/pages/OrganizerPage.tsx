import { fetchOrganizer } from '../lib/client'
import { useResource } from '../lib/useResource'
import { useT } from '../i18n'
import { Alert, Badge } from '../components/primitives'
import { PlaceHeader, PlacePage, PlaceMissing, PlaceSkeleton } from './PlaceLayout'

/** An organizer's page (#44): who they are and everything they have listed. */
export function OrganizerPage({ slug }: { slug: string }) {
  const t = useT()
  const { data, loading, missing, error } = useResource(
    (signal) => fetchOrganizer(slug, signal), [slug],
  )

  if (loading) return <PlaceSkeleton />
  if (missing) {
    return (
      <PlaceMissing
        title={t('organizers.title')}
        body={t('place.nothingAtAll')}
        backHref="/organizers"
        backLabel={t('organizers.title')}
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

  const { organizer } = data

  return (
    <PlacePage
      pastHeading="elsewhere"
      upcoming={data.listings}
      past={data.past}
      header={
        <PlaceHeader
          name={organizer.name}
          kind={t('organizers.title')}
          description={organizer.description}
          counts={{
            upcoming: organizer.upcoming_listing_count,
            past: organizer.past_listing_count,
          }}
          meta={
            <div className="place-header__meta">
              {organizer.is_verified && <Badge tone="success">{t('listing.verified')}</Badge>}
              {organizer.website_url && (
                <p>
                  <a href={organizer.website_url} target="_blank" rel="noopener noreferrer">
                    {t('place.website')}
                  </a>
                </p>
              )}
            </div>
          }
        />
      }
    />
  )
}
