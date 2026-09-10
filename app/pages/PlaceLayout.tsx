import type { ReactNode } from 'react'
import type { Listing } from '../lib/catalog'
import { count } from '../lib/format'
import { useLanguage, useT } from '../i18n'
import { Alert, Badge, Button, Skeleton } from '../components/primitives'
import { ListingCard, ListingCardSkeleton } from '../components/ListingCard'
import { Link } from '../router'

/**
 * The shape every entity page shares (#44): who or what this is, what is on,
 * and what has been.
 *
 * Venues, organizers and artists differ in their header and in nothing else,
 * so the two lists and their empty states live here once. The rule that makes
 * these pages worth having is in `Listings` below: **a page with nothing
 * coming up shows what has been rather than an empty page**, because a venue
 * between seasons is a venue people are still looking up, and "nothing here"
 * reads as "this place is closed".
 */
export function PlacePage({ header, upcoming, past, pastHeading }: {
  header: ReactNode
  upcoming: Listing[]
  past: Listing[]
  /** Venues say "Previously here"; an organizer's history was not *here*. */
  pastHeading?: 'here' | 'elsewhere'
}) {
  const t = useT()
  const nothingAtAll = upcoming.length === 0 && past.length === 0

  return (
    <div className="layout stack place-page">
      {header}

      {nothingAtAll ? (
        <Alert tone="info">{t('place.nothingAtAll')}</Alert>
      ) : (
        <>
          <section className="stack" aria-labelledby="upcoming-heading">
            <h2 id="upcoming-heading">{t('place.upcoming')}</h2>
            {upcoming.length === 0
              ? <p className="rail__empty">{t('place.nothingUpcoming')}</p>
              : <Listings listings={upcoming} />}
          </section>

          {past.length > 0 && (
            <section className="stack place-page__past" aria-labelledby="past-heading">
              <h2 id="past-heading">
                {t(pastHeading === 'elsewhere' ? 'place.pastElsewhere' : 'place.past')}
              </h2>
              <Listings listings={past} />
            </section>
          )}
        </>
      )}
    </div>
  )
}

function Listings({ listings }: { listings: Listing[] }) {
  return (
    <ul className="grid" role="list">
      {listings.map((listing) => (
        <li key={listing.id}><ListingCard listing={listing} /></li>
      ))}
    </ul>
  )
}

/**
 * The header every entity page shares: a name, what it is, how much of it
 * there is, and the follow entry point.
 *
 * **Follow is present and honest.** #44 puts the entry point in scope and the
 * wiring out of it, so this renders a disabled control that says when it
 * arrives rather than a live-looking button that does nothing. A button that
 * silently fails is worse than one that explains itself.
 */
export function PlaceHeader({ name, kind, description, counts, meta, children }: {
  name: string
  kind: string
  description?: string | null
  counts: { upcoming: number; past: number }
  meta?: ReactNode
  children?: ReactNode
}) {
  const t = useT()
  const { language } = useLanguage()

  return (
    <header className="place-header">
      <div className="place-header__main">
        <p className="place-header__kind">{kind}</p>
        <h1>{name}</h1>
        <p className="place-header__counts">
          <Badge tone="accent">
            {t('place.count.upcoming', { count: count(counts.upcoming, language) })}
          </Badge>
          {counts.past > 0 && (
            <Badge>{t('place.count.past', { count: count(counts.past, language) })}</Badge>
          )}
        </p>
        {description && <p className="place-header__description">{description}</p>}
        {meta}
      </div>
      <div className="place-header__actions">
        {children}
        <Button variant="secondary" size="sm" disabled aria-describedby="follow-note">
          {t('place.follow')}
        </Button>
        <span id="follow-note" className="place-header__note">{t('place.followSoon')}</span>
      </div>
    </header>
  )
}

export function PlaceSkeleton() {
  const t = useT()
  return (
    <div className="layout stack place-page" aria-busy="true">
      <span className="visually-hidden" role="status">{t('common.loading')}</span>
      <div className="stack">
        <Skeleton width="20%" height="0.9rem" />
        <Skeleton width="45%" height="2.25rem" />
        <Skeleton width="65%" height="1rem" />
      </div>
      <ul className="grid" role="list">
        {[0, 1, 2, 3].map((index) => <li key={index}><ListingCardSkeleton /></li>)}
      </ul>
    </div>
  )
}

/** The 404 an entity page shows: an explanation and a way onwards. */
export function PlaceMissing({ title, body, backHref, backLabel }: {
  title: string
  body: string
  backHref: string
  backLabel: string
}) {
  return (
    <div className="layout stack">
      <h1>{title}</h1>
      <Alert tone="info" title={title}>{body}</Alert>
      <p><Link href={backHref}>{backLabel}</Link></p>
    </div>
  )
}
