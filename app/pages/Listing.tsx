import { createContext, useContext, useEffect, useId, useState } from 'react'
import type { Listing, ListingDetail } from '../lib/catalog'
import { fetchListing } from '../lib/client'
import { useResource } from '../lib/useResource'
import { recordListingEvent } from '../lib/analytics'
import {
  categoryName, descriptionOf, langOf, money, offerLine, relativeDay, startBikram, startLine,
  startTime, summaryOf, titleOf, venueLine,
} from '../lib/format'
import { calendarEventFor, googleCalendarUrl, toICal } from '../lib/calendar'
import { directionsUrl, shareTargets, siteOrigin } from '../lib/share'
import { useLanguage, useT } from '../i18n'
import { Alert, Badge, Button, Card, Skeleton } from '../components/primitives'
import { ResponsiveImage } from '../components/ResponsiveImage'
import { ListingCard } from '../components/ListingCard'
import { listingImages } from '../lib/listingImages'
import { Description } from '../components/Description'
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
 *
 * **A card opens the listing in a dialog** (`ListingDialog`), so a reader
 * browsing a row does not lose their place. The dialog shows `ListingGlance`,
 * everything needed to decide and act without scrolling, and links here for
 * the rest.
 */
const HERO_SIZES = '(max-width: 60rem) 100vw, 60rem'

/**
 * The heading level the content starts at. Sections and panels take the next
 * one down, so a description rendered under an `h2` title has `h3` headings.
 */
const LevelContext = createContext<1 | 2>(1)
const useHeadings = () => {
  const level = useContext(LevelContext)
  return { Title: level === 1 ? 'h1' : 'h2', Section: level === 1 ? 'h2' : 'h3' } as const
}

export function ListingPage({ slug }: { slug: string }) {
  const t = useT()
  const { data, loading, missing, error } = useResource(
    (signal) => fetchListing(slug, signal), [slug], `/listings/${slug}`,
  )

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

  return data ? (
    <article className="layout listing-page">
      <ListingContent listing={data} />
    </article>
  ) : null
}

/**
 * Everything a listing shows, from the category line to the related cards.
 * `level` is where its headings start: 1 on the page, 2 in the dialog.
 */
export function ListingContent({ listing, level = 1, titleId }: {
  listing: ListingDetail
  level?: 1 | 2
  /** For a dialog to label itself by the title. */
  titleId?: string
}) {
  // Counted once the listing is known to exist (#34). Firing on a 404 would
  // teach the dashboard that a mistyped URL is a view.
  useEffect(() => { recordListingEvent(listing.slug, 'view') }, [listing.slug])

  return (
    <LevelContext.Provider value={level}>
      <Loaded listing={listing} titleId={titleId} />
    </LevelContext.Provider>
  )
}

/**
 * A listing at a glance, for the dialog: the poster beside what, when, where
 * and what it costs, with every action one click away. The page keeps the
 * rest (line-up, gallery, map, related), one link from here.
 *
 * Returns the poster and the details as siblings, so the dialog can place
 * them in its own grid next to its bar.
 */
export function ListingGlance({ listing, titleId }: { listing: ListingDetail; titleId?: string }) {
  const t = useT()
  const { language } = useLanguage()
  const [added, setAdded] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => { recordListingEvent(listing.slug, 'view') }, [listing.slug])

  // Opening a related listing reuses this component; its buttons start fresh.
  useEffect(() => { setAdded(false); setCopied(false) }, [listing.slug])

  // "Link copied" is a moment, not a state: it goes back so a second copy reads
  // as one.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const title = titleOf(listing, language)
  // The summary where the author wrote one; otherwise the description's first
  // paragraph, which CSS cuts to a few lines. The rest is on the page.
  const blurb = summaryOf(listing, language) ?? descriptionOf(listing, language)
    ?.split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/^\s*Source\s*:.*$/gim, '').trim())
    .find(Boolean)
  const blurbLang = listing.summary ? langOf(listing.summary_ne, language) : langOf(listing.description_ne, language)
  const [hero] = listingImages(listing)
  const category = listing.categories.find((entry) => entry.is_primary) ?? listing.categories[0]
  const bikram = startBikram(listing, language)
  const venue = listing.venue
  // The area under the venue's name, unless the name already says it
  // ("CCT, Bharatpur, Chitwan" does not need "Chitwan" again).
  const place = venue ? [venue.area ?? venue.city, venue.address].find((part) => part && !venue.name.includes(part)) : null
  const price = listing.listing_type === 'free' ? t('listing.free')
    : listing.listing_type === 'announcement' ? t('listing.announcement')
    : offerLine(listing, language)

  const offer = listing.offer
  const cta = offer?.url && !offer.sold_out && listing.listing_type !== 'free' && listing.listing_type !== 'announcement'
    ? { href: offer.url, label: t('listing.getTickets') }
    : listing.external_url ? { href: listing.external_url, label: t('listing.visitSite') } : null

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${siteOrigin()}/listings/${listing.slug}`)
      setCopied(true)
    } catch {
      // Refused clipboard: the link is in the address bar either way.
    }
  }

  return (
    <>
      {hero && (
        <div className="glance__poster">
          <a href={hero.url} target="_blank" rel="noopener noreferrer">
            <ResponsiveImage media={hero} sizes="(max-width: 40rem) 100vw, 32rem" alt={hero.alt_text || title} priority />
          </a>
        </div>
      )}

      <div className="glance__details">
        {category && (
          <span className="listing-page__category" style={{ ['--card-accent' as string]: category.color ?? undefined }}>
            {categoryName(category, language)}
          </span>
        )}
        <h2 id={titleId} className="glance__title" lang={langOf(listing.title_ne, language)}>{title}</h2>

        <ul className="glance__facts" role="list">
          <li className="glance__fact">
            <FactIcon d="M4 5h16v15H4zM16 3v4M8 3v4M4 10h16" />
            <div>
              <p className="glance__fact-main">
                <time dateTime={listing.starts_at}>{startLine(listing, language)}</time>
                {listing.ends_at && !listing.is_all_day && (
                  <> {t('listing.until', { end: startTime({ ...listing, starts_at: listing.ends_at }, language) })}</>
                )}
              </p>
              {bikram && <p className="glance__fact-sub" lang="ne">{bikram}</p>}
            </div>
          </li>
          {venue && (
            <li className="glance__fact">
              <FactIcon d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
              <div>
                <p className="glance__fact-main">
                  <Link href={`/venues/${venue.slug}`}>{venue.name}</Link>
                  {listing.venue_room && <> — {listing.venue_room}</>}
                </p>
                <p className="glance__fact-sub">
                  {place && <>{place} · </>}
                  <a href={directionsUrl(venue)} target="_blank" rel="noopener noreferrer">{t('listing.directions')}</a>
                </p>
              </div>
            </li>
          )}
          {price && (
            <li className="glance__fact">
              <FactIcon d="M3 9a3 3 0 0 0 0 6v4h18v-4a3 3 0 0 0 0-6V5H3zM13 5v2M13 11v2M13 17v2" />
              <p className="glance__fact-main">{price}</p>
            </li>
          )}
        </ul>

        {blurb && <p className="glance__blurb" lang={blurbLang}>{blurb}</p>}
        <Link className="glance__more" href={`/listings/${listing.slug}`}>{t('listing.fullDetails')} →</Link>

        <div className="glance__actions">
          {cta && (
            <a
              className="btn btn--primary btn--lg btn--block"
              href={cta.href}
              target="_blank"
              rel="noopener noreferrer"
              // The click is the attribution (#34, #43), as on the page.
              onClick={() => recordListingEvent(listing.slug, 'click')}
            >
              {cta.label} <span aria-hidden="true">↗</span>
            </a>
          )}
          <div className="glance__secondary">
            <Button variant="secondary" onClick={() => { downloadICal(listing); setAdded(true) }}>
              {added ? <>✓ {t('listing.addedToCalendar')}</> : t('listing.addToCalendar')}
            </Button>
            <Button variant="secondary" onClick={copyLink}>
              {copied ? <>✓ {t('listing.linkCopied')}</> : t('listing.copyLink')}
            </Button>
          </div>
          <span role="status" className="visually-hidden">
            {copied ? t('listing.linkCopied') : added ? t('listing.addedToCalendar') : ''}
          </span>
        </div>
      </div>
    </>
  )
}

function FactIcon({ d }: { d: string }) {
  return (
    <span className="glance__icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </span>
  )
}

function Loaded({ listing, titleId }: { listing: ListingDetail; titleId?: string }) {
  const t = useT()
  const { language } = useLanguage()
  const { Title, Section } = useHeadings()
  // Generated, not fixed: the dialog can open over the listing page itself
  // (a related card), and then there are two of every section on the document.
  const ids = useId()
  const title = titleOf(listing, language)
  const summary = summaryOf(listing, language)
  // Imported source URLs stay in the stored description for record-keeping.
  const description = descriptionOf(listing, language)
    ?.split(/\r?\n/)
    .filter((line) => !/^\s*Source\s*:/i.test(line))
    .join('\n')
    .trim()
  const [hero, ...gallery] = listingImages(listing)
  const category = listing.categories.find((entry) => entry.is_primary) ?? listing.categories[0]

  return (
    <>
      <header className="listing-page__head">
        {category && (
          <span className="listing-page__category" style={{ ['--card-accent' as string]: category.color ?? undefined }}>
            {categoryName(category, language)}
          </span>
        )}
        <Title id={titleId} className="listing-page__title" lang={langOf(listing.title_ne, language)}>{title}</Title>
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
          <a href={hero.url} target="_blank" rel="noopener noreferrer">
            <ResponsiveImage media={hero} sizes={HERO_SIZES} alt={hero.alt_text || title} priority />
          </a>
        </div>
      )}

      <div className="listing-page__body">
        <div className="listing-page__main">
          {description && (
            <section className="stack listing-page__section" aria-labelledby={`${ids}about`}>
              <Section id={`${ids}about`}>{t('listing.about')}</Section>
              <Description text={description} lang={langOf(listing.description_ne, language)} />
            </section>
          )}

          {listing.artists.length > 0 && (
            <section className="stack" aria-labelledby={`${ids}lineup`}>
              <Section id={`${ids}lineup`}>{t('listing.lineup')}</Section>
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

          {gallery.length > 0 && (
            <section className="stack" aria-labelledby={`${ids}gallery`}>
              <Section id={`${ids}gallery`}>{t('listing.gallery')}</Section>
              <ul className="gallery" role="list">
                {gallery.map((item) => (
                  <li key={item.id}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                      <ResponsiveImage media={item} sizes="(max-width: 40rem) 90vw, 20rem" alt={item.alt_text || title} />
                    </a>
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
              <Section className="panel__heading">{t('listing.organizer')}</Section>
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
    </>
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
  const { Section } = useHeadings()
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
        <Section className="panel__heading">{t('listing.tickets')}</Section>
        <p className="text-muted">{t('listing.offerUnavailable')}</p>
        {listing.external_url && <ExternalLink listing={listing} />}
      </Card>
    )
  }

  return (
    <Card raised>
      <Section className="panel__heading">{t('listing.tickets')}</Section>
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
  const { Section } = useHeadings()
  const bikram = startBikram(listing, language)
  const [copied, setCopied] = useState(false)

  return (
    <Card>
      <Section className="panel__heading">{t('listing.when')}</Section>
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
  const { Section } = useHeadings()
  const venue = listing.venue
  if (!venue) return null

  return (
    <Card>
      <Section className="panel__heading">{t('listing.where')}</Section>
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
  const { Section } = useHeadings()
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
      <Section className="panel__heading">{t('listing.share')}</Section>
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
  const { Section } = useHeadings()
  const id = useId()
  return (
    <section className="stack" aria-labelledby={id}>
      <Section id={id}>{t('listing.related')}</Section>
      <ul className="grid" role="list">
        {listings.map((listing) => (
          <li key={listing.id}><ListingCard listing={listing} /></li>
        ))}
      </ul>
    </section>
  )
}

export function ListingSkeleton() {
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
