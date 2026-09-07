import type { Listing } from '../lib/catalog'
import { Badge } from './primitives'
import { LISTING_TYPE_LABEL, offerLine, startDay, startTime, venueLine } from '../lib/format'
import { Link } from '../router'

/**
 * The listing card (#41), in two layouts: `grid` fills a responsive grid,
 * `row` is a fixed-width tile inside a horizontal rail.
 *
 * No cover image is seeded yet (#25 brings the media pipeline), and a card that
 * waits for one is a card that shows a grey box for the whole of M2. The poster
 * is drawn from the listing's first category colour instead, so it is
 * distinctive per category, needs no network, and — because it is CSS with a
 * fixed aspect ratio — leaves nothing to shift when a real image arrives.
 */
export function ListingCard({ listing, layout = 'grid' }: {
  listing: Listing
  layout?: 'grid' | 'row'
}) {
  const { day, month, weekday } = startDay(listing)
  const category = listing.categories[0]
  const place = venueLine(listing)
  const price = offerLine(listing)
  const typeLabel = LISTING_TYPE_LABEL[listing.listing_type]

  return (
    <article
      className={`listing-card listing-card--${layout}`}
      // The category colour is data, not a design token: it comes from the
      // catalogue, so it is set as a custom property here rather than in CSS.
      style={category?.color ? { ['--card-accent' as string]: category.color } : undefined}
    >
      <Link className="listing-card__link" href={`/listings/${listing.slug}`}>
        <div className="listing-card__poster" aria-hidden="true">
          {listing.cover_image_url ? (
            <img src={listing.cover_image_url} alt="" loading="lazy" decoding="async" />
          ) : (
            <div className="listing-card__date">
              <span className="listing-card__date-weekday">{weekday}</span>
              <span className="listing-card__date-day">{day}</span>
              <span className="listing-card__date-month">{month}</span>
            </div>
          )}
        </div>

        <div className="listing-card__body">
          {category && <span className="listing-card__category">{category.name}</span>}
          <h3 className="listing-card__title">{listing.title}</h3>

          {/* The date is in the poster for sighted users; a screen reader gets
              it here, where it reads as part of the sentence. */}
          <p className="listing-card__when">
            <span className="visually-hidden">{`${weekday} ${day} ${month}, `}</span>
            {startTime(listing)}
            {place && <span className="listing-card__where"> · {place}</span>}
          </p>
        </div>
      </Link>

      {(price || typeLabel) && (
        <div className="listing-card__foot">
          {price && <span className="listing-card__price">{price}</span>}
          {typeLabel && typeLabel !== price && <Badge>{typeLabel}</Badge>}
        </div>
      )}
    </article>
  )
}

/**
 * The card's own shape, drawn while the data is still in flight. It matches the
 * real card's dimensions exactly — that is the whole point, and it is what
 * keeps the feed from jumping when the response lands.
 */
export function ListingCardSkeleton({ layout = 'grid' }: { layout?: 'grid' | 'row' }) {
  return (
    <div className={`listing-card listing-card--${layout} listing-card--skeleton`} aria-hidden="true">
      <div className="listing-card__poster skeleton" />
      <div className="listing-card__body">
        <div className="skeleton" style={{ width: '40%', height: '0.75rem' }} />
        <div className="skeleton" style={{ width: '90%', height: '1.1rem' }} />
        <div className="skeleton" style={{ width: '65%', height: '0.85rem' }} />
      </div>
    </div>
  )
}
