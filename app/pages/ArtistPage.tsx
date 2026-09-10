import { fetchArtist } from '../lib/client'
import { useResource } from '../lib/useResource'
import { useT } from '../i18n'
import { Alert } from '../components/primitives'
import { PlaceHeader, PlacePage, PlaceMissing, PlaceSkeleton } from './PlaceLayout'

/**
 * An artist's page (#44), where there is enough for one.
 *
 * The threshold lives in the API (`ARTIST_PAGE_THRESHOLD`), which 404s below
 * it — so this page's "no page for that artist" is the same rule the listing
 * page uses to decide whether to link here at all, read from one place rather
 * than guessed at in two.
 */
export function ArtistPage({ slug }: { slug: string }) {
  const t = useT()
  const { data, loading, missing, error } = useResource(
    (signal) => fetchArtist(slug, signal), [slug], `/artists/${slug}`,
  )

  if (loading) return <PlaceSkeleton />
  if (missing) {
    return (
      <PlaceMissing
        title={t('artist.notFound')}
        body={t('artist.notFoundBody')}
        backHref="/"
        backLabel={t('common.backHome')}
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

  const { artist } = data

  return (
    <PlacePage
      pastHeading="elsewhere"
      upcoming={data.listings}
      past={data.past}
      header={
        <PlaceHeader
          name={artist.name}
          kind={t('artist.title')}
          description={artist.bio}
          counts={{
            upcoming: artist.upcoming_listing_count,
            past: Math.max(0, artist.listing_count - artist.upcoming_listing_count),
          }}
          meta={
            Object.keys(artist.links).length > 0 ? (
              <ul className="place-header__facts" role="list">
                {Object.entries(artist.links).map(([label, href]) => (
                  <li key={label}>
                    <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
                  </li>
                ))}
              </ul>
            ) : null
          }
        />
      }
    />
  )
}
