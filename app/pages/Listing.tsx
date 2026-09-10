import { useEffect, useState } from 'react'
import type { Listing, ListingDetail } from '../lib/catalog'
import { fetchListing } from '../lib/client'
import { useResource } from '../lib/useResource'
import { recordListingEvent } from '../lib/analytics'
import {
  categoryName, descriptionOf, langOf, money, relativeDay, startBikram, startLine,
  startTime, summaryOf, titleOf, venueLine,
} from '../lib/format'
import { calendarEventFor, googleCalendarUrl, toICal } from '../lib/calendar'
import { directionsUrl, shareTargets, siteOrigin } from '../lib/share'
import { useLanguage, useT } from '../i18n'
import { Alert, Badge, Button, Card, Skeleton } from '../components/primitives'
import { ResponsiveImage } from '../components/ResponsiveImage'
import { ListingCard } from '../components/ListingCard'
import { StaticMap } from '../components/StaticMap'
import { Link } from '../router'

/**
 * The listing page (#43) — the destination everything else points at, and the
 * page most inbound search traffic will land on.
 *
 * WaahTickets had no equivalent: it showed a popup on the map and scrolled to
 * a grid tile, which works inside a session and gives a shared link nothing to
 * point at.
 *
 * **The offer section is the seam, and it degrades.** Everything above it —
 * what, when, where, who — comes from the catalogue and always renders. The
 * offer is a snapshot the catalogue was given (docs/SCOPE.md); when it is
 * missing the page says so quietly and keeps the rest, because a page that
 * fails because a price could not be resolved is a discovery product held
 * hostage by a commerce one.
 */
const HERO_SIZES = '(max-width: 60rem) 100vw, 60rem'

export function ListingPage({ slug }: { slug: string }) {
  const t = useT()
  const { data, loading, missing, error } = useResource(
    (signal) => fetchListing(slug, signal), [slug], `/listings/${slug}`,
  )

  // Counted once the listing is known to exist (#34). Firing on a 404 would
  // teach the dashboard that a mistyped URL is a view.
  useEffect(() => { if (data) recordListingEvent(slug, 'view') }, [data, slug])

  if (loading) return <ListingSkeleton />

  if (missing || (error && !data)) {
    return (
      <div className="layout stack">
        <h1>{missing ? t('listing.notFound') : t('common.error')}</h1>
        <Alert tone={missing ? 'info' : 'danger'} title={missing ? t('listing.notFound') : t('common.error')}>
          {missing ? t('listing.notFoundBody') : error?.message}
        </Alert>
        <p><Link href="/">{t('common.backHome')}</Link></p>
      </div>
    )
  }

  return data ? <Loaded listing={data} /> : null
}

function Loaded({ listing }: { listing: ListingDetail }) {
  const t = useT()
  const { language } = useLanguage()
  const title = titleOf(listing, language)
  const summary = summaryOf(listing, language)
  const description = descriptionOf(listing, language)
  const hero = listing.media.find((item) => item.kind === 'image') ?? null
  const category = listing.categories.find((entry) => entry.is_primary) ?? listing.categories[0]

  return (
    <article className="layout listing-page">
      <header className="listing-page__head">
        {category && (
          <span className="listing-page__category" style={{ ['--card-accent' as string]: category.color ?? undefined }}>
            {categoryName(category, language)}
          </span>
        )}
        <h1 className="listing-page__title" lang={langOf(listing.title_ne, language)}>{title}</h1>
        {summary && (
          <p className="listing-page__summary" lang={langOf(listing.summary_ne, language)}>{summary}</p>
        )}
        <p className="listing-page__meta">
          <time dateTime={listing.starts_at}>{startLine(listing, language)}</time>
          {listing.venue && (
            <>
              {' · '}
              <Link href={`/venues/${listing.venue.slug}`}>{venueLine(listing)}</Link>
            </>
          )}
        </p>
      </header>

      {hero && (
        <div className="listing-page__hero">
          {/* The hero is the listing's own poster, so its alt text is the one
              the author wrote — unlike a card, where the title is right next
              to it and repeating it reads the listing twice. */}
          <ResponsiveImage media={hero} sizes={HERO_SIZES} priority />
        </div>
      )}

      <div className="listing-page__body">
        <div className="listing-page__main">
          {description && (
            <section className="stack" aria-labelledby="about-heading">
              <h2 id="about-heading">{t('listing.about')}</h2>
              {/* Paragraphs, not `dangerouslySetInnerHTML`: the description is
                  author-supplied text and this is the one place it is rendered
                  at full length. Splitting on blank lines keeps the shape the
                  author typed without letting them inject markup. */}
              <div className="prose" lang={langOf(listing.description_ne, language)}>
                {description.split(/\n{2,}/).map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
              </div>
            </section>
          )}

          {listing.artists.length > 0 && (
            <section className="stack" aria-labelledby="lineup-heading">
              <h2 id="lineup-heading">{t('listing.lineup')}</h2>
              <ul className="lineup" role="list">
                {listing.artists.map((artist) => (
                  <li key={artist.slug} className="lineup__artist">
                    {/* Linked only where the API says it will serve a page.
                        The flag travels with the artist for exactly this, so
                        the threshold lives in one place. */}
                    {artist.has_page
                      ? <Link href={`/artists/${artist.slug}`}>{artist.name}</Link>
                      : <span>{artist.name}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {listing.media.length > 1 && (
            <section className="stack" aria-labelledby="gallery-heading">
              <h2 id="gallery-heading">{t('listing.gallery')}</h2>
              <ul className="gallery" role="list">
                {listing.media.slice(1).map((item) => (
                  <li key={item.id}>
                    <ResponsiveImage media={item} sizes="(max-width: 40rem) 45vw, 18rem" />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {listing.tags.length > 0 && (
            <ul className="tag-list" role="list">
              {listing.tags.map((tag) => (
                <li key={tag.slug}>
                  <Link className="tag-list__tag" href={`/search?tag=${encodeURIComponent(tag.slug)}`}>
                    {tag.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="listing-page__aside">
          <OfferPanel listing={listing} />
          <WhenPanel listing={listing} />
          {listing.venue && <WherePanel listing={listing} />}
          {listing.organizer && (
            <Card>
              <h2 className="panel__heading">{t('listing.organizer')}</h2>
              <p>
                <Link href={`/organizers/${listing.organizer.slug}`}>{listing.organizer.name}</Link>
                {listing.organizer.is_verified && <> <Badge tone="success">{t('listing.verified')}</Badge></>}
              </p>
            </Card>
          )}
          <SharePanel listing={listing} title={title} />
        </aside>
      </div>

      {listing.related.length > 0 && <Related listings={listing.related} />}
    </article>
  )
}

/**
 * The offer, or its absence, said out loud.
 *
 * Four cases and they are genuinely different: a free listing has no price and
 * no button; an announcement has nothing to buy yet; a ticketed listing with a
 * resolved offer gets a button; and a ticketed listing whose offer could not be
 * resolved says so and offers the event's own site instead. The last one is
 * the degradation #43 asks for, and it is a rendered state rather than a
 * missing element so that it is visible in a screenshot when it happens.
 */
function OfferPanel({ listing }: { listing: ListingDetail }) {
  const t = useT()
  const { language } = useLanguage()
  const offer = listing.offer

  if (listing.listing_type === 'free') {
    return (
      <Card raised>
        <p className="offer__headline">{t('listing.free')}</p>
        {listing.external_url && <ExternalLink listing={listing} />}
      </Card>
    )
  }

  if (listing.listing_type === 'announcement') {
    return (
      <Card>
        <p className="offer__headline">{t('listing.announcement')}</p>
        {listing.external_url && <ExternalLink listing={listing} />}
      </Card>
    )
  }

  if (!offer || !offer.url) {
    return (
      <Card>
        <h2 className="panel__heading">{t('listing.tickets')}</h2>
        <p className="text-muted">{t('listing.offerUnavailable')}</p>
        {listing.external_url && <ExternalLink listing={listing} />}
      </Card>
    )
  }

  return (
    <Card raised>
      <h2 className="panel__heading">{t('listing.tickets')}</h2>
      {offer.sold_out ? (
        <p className="offer__headline">{t('listing.soldOut')}</p>
      ) : (
        <>
          {offer.price_from !== null && offer.price_from > 0 && (
            <p className="offer__headline">
              {t('listing.priceFrom', { price: money(offer.price_from, offer.currency, language) })}
            </p>
          )}
          <a
            className="btn btn--primary btn--block"
            href={offer.url}
            target="_blank"
            rel="noopener noreferrer"
            // The click is the attribution (#34, #43): it is what tells an
            // organizer that people did not merely look.
            onClick={() => recordListingEvent(listing.slug, 'click')}
          >
            {t('listing.getTickets')}
          </a>
        </>
      )}
      {offer.checked_at && (
        <p className="offer__checked">
          {t('listing.priceChecked', { when: relativeDay(offer.checked_at, language) })}
        </p>
      )}
    </Card>
  )
}

/** An external listing links out, and the click is recorded for attribution. */
function ExternalLink({ listing }: { listing: ListingDetail }) {
  const t = useT()
  return (
    <a
      className="btn btn--secondary btn--block"
      href={listing.external_url ?? '#'}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => recordListingEvent(listing.slug, 'click')}
    >
      {t('listing.visitSite')}
    </a>
  )
}

function WhenPanel({ listing }: { listing: ListingDetail }) {
  const t = useT()
  const { language } = useLanguage()
  const bikram = startBikram(listing, language)
  const [copied, setCopied] = useState(false)

  return (
    <Card>
      <h2 className="panel__heading">{t('listing.when')}</h2>
      <p>
        <time dateTime={listing.starts_at}>{startLine(listing, language)}</time>
        {listing.ends_at && !listing.is_all_day && (
          <> {t('listing.until', { end: startTime({ ...listing, starts_at: listing.ends_at }, language) })}</>
        )}
      </p>
      {/* Bikram Sambat beside the Gregorian date, never instead of it (#46). */}
      {bikram && <p className="text-muted" lang="ne">{bikram}</p>}

      <div className="panel__actions">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { downloadICal(listing); setCopied(true) }}
        >
          {t('listing.addToCalendar')}
        </Button>
        <a
          className="btn btn--ghost btn--sm"
          href={googleCalendarUrl(calendarEventFor(listing, siteOrigin()))}
          target="_blank"
          rel="noopener noreferrer"
        >
          Google Calendar
        </a>
      </div>
      {/* A download gives no feedback of its own on mobile, where the file
          lands in a tray the reader has to go and find. */}
      <span role="status" className="visually-hidden">
        {copied ? t('listing.addToCalendar') : ''}
      </span>
    </Card>
  )
}

function downloadICal(listing: ListingDetail) {
  const event = calendarEventFor(listing, siteOrigin())
  const blob = new Blob([toICal(event)], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${listing.slug}.ics`
  anchor.click()
  // Revoked on the next tick: revoking synchronously races the download on
  // Safari, which has not finished reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function WherePanel({ listing }: { listing: ListingDetail }) {
  const t = useT()
  const venue = listing.venue
  if (!venue) return null

  return (
    <Card>
      <h2 className="panel__heading">{t('listing.where')}</h2>
      <p>
        <Link href={`/venues/${venue.slug}`}>{venue.name}</Link>
        {listing.venue_room && <> — {listing.venue_room}</>}
      </p>
      {venue.address && <p className="text-muted">{venue.address}</p>}
      <StaticMap
        latitude={listing.latitude ?? venue.latitude}
        longitude={listing.longitude ?? venue.longitude}
        label={venue.name}
        pin={listing.pin}
      />
      <a
        className="btn btn--secondary btn--sm"
        href={directionsUrl({ ...venue, name: venue.name })}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t('listing.directions')}
      </a>
    </Card>
  )
}

function SharePanel({ listing, title }: { listing: ListingDetail; title: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const url = `${siteOrigin()}/listings/${listing.slug}`

  const labels = {
    whatsapp: t('listing.shareWhatsApp'),
    facebook: t('listing.shareFacebook'),
    x: t('listing.shareX'),
    copy: t('listing.copyLink'),
  } as const

  return (
    <Card>
      <h2 className="panel__heading">{t('listing.share')}</h2>
      <ul className="share" role="list">
        {shareTargets(url, title).map((target) => (
          <li key={target.id}>
            {target.href ? (
              <a className="share__link" href={target.href} target="_blank" rel="noopener noreferrer">
                {labels[target.id]}
              </a>
            ) : (
              <button
                type="button"
                className="share__link"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url)
                    setCopied(true)
                  } catch {
                    // Clipboard access can be refused; the URL is in the
                    // address bar either way, so this is not worth an error.
                  }
                }}
              >
                {copied ? t('listing.linkCopied') : labels.copy}
              </button>
            )}
          </li>
        ))}
      </ul>
      <span role="status" className="visually-hidden">{copied ? t('listing.linkCopied') : ''}</span>
    </Card>
  )
}

function Related({ listings }: { listings: Listing[] }) {
  const t = useT()
  return (
    <section className="stack" aria-labelledby="related-heading">
      <h2 id="related-heading">{t('listing.related')}</h2>
      <ul className="grid" role="list">
        {listings.map((listing) => (
          <li key={listing.id}><ListingCard listing={listing} /></li>
        ))}
      </ul>
    </section>
  )
}

function ListingSkeleton() {
  const t = useT()
  return (
    <div className="layout listing-page" aria-busy="true">
      <span className="visually-hidden" role="status">{t('common.loading')}</span>
      <div className="stack">
        <Skeleton width="30%" height="1rem" />
        <Skeleton width="80%" height="2.5rem" />
        <Skeleton width="55%" height="1rem" />
      </div>
      <div className="listing-page__hero skeleton" style={{ aspectRatio: '16 / 9' }} />
      <div className="listing-page__body">
        <div className="listing-page__main stack">
          <Skeleton height="1rem" />
          <Skeleton height="1rem" />
          <Skeleton width="70%" height="1rem" />
        </div>
        <div className="listing-page__aside">
          <Skeleton height="9rem" />
        </div>
      </div>
    </div>
  )
}
