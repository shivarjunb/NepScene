import type { Listing } from '../lib/catalog'
import { Badge } from './primitives'
import { ResponsiveImage } from './ResponsiveImage'
import { categoryName, langOf, offerLine, startDay, startTime, titleOf, venueLine } from '../lib/format'
import { useLanguage, useT } from '../i18n'
import { Link } from '../router'

/**
 * A row card is 300px (82vw on a phone); a grid card is one column of a four,
 * two or one-up grid. Without a `sizes` hint the browser assumes full-viewport
 * width and fetches the widest rung there is, which is the whole feature
 * undone.
 */
const GRID_SIZES = '(max-width: 40rem) 100vw, (max-width: 68.75rem) 45vw, 25vw'
const ROW_SIZES = '(max-width: 40rem) 82vw, 18.75rem'

/**
 * The listing card (#41), in two layouts: `grid` fills a responsive grid,
 * `row` is a fixed-width tile inside a horizontal rail.
 *
 * The poster shows the listing's cover through the media pipeline (#25) when it
 * has one, an authored `cover_image_url` when that is all an import gave us,
 * and otherwise the date on the marketplace's violet night. All three occupy
 * the same fixed 16:10 box, so which one a listing gets changes nothing about
 * the page's layout.
 */
export function ListingCard({ listing, layout = 'grid' }: {
  listing: Listing
  layout?: 'grid' | 'row'
}) {
  const t = useT()
  const { language } = useLanguage()
  const { day, month, weekday } = startDay(listing, language)
  const hasPoster = Boolean(listing.cover || listing.cover_image_url)
  const category = listing.categories[0]
  const place = venueLine(listing)
  const price = offerLine(listing, language)
  // Translated rather than looked up from a table of English labels, so the
  // badge is in the reader's language like everything else on the card (#46).
  const typeLabel = listing.listing_type === 'ticketed_external'
    ? t('listing.externalTickets')
    : listing.listing_type === 'free' ? t('listing.free')
    : listing.listing_type === 'announcement' ? t('listing.announcement')
    : null

  return (
    <article
      className={`listing-card listing-card--${layout}`}
      // The category colour is data, not a design token: it comes from the
      // catalogue, so it is set as a custom property here rather than in CSS.
      style={category?.color ? { ['--card-accent' as string]: category.color } : undefined}
    >
      <Link className="listing-card__link" href={`/listings/${listing.slug}`}>
        <div className="listing-card__poster" aria-hidden="true">
          {/* Over a photograph the date floats on a pill; with no photograph
              the poster already *is* the date, and two of them is one too
              many. */}
          {hasPoster && (
            <span className="listing-card__badge">{`${day} ${month}`}</span>
          )}
          {listing.cover ? (
            // The title is right there in the card, so the poster is decorative
            // here — repeating the alt text would make a screen reader read the
            // same listing twice.
            <ResponsiveImage
              media={listing.cover}
              alt=""
              sizes={layout === 'row' ? ROW_SIZES : GRID_SIZES}
            />
          ) : listing.cover_image_url ? (
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
          {category && (
            <span className="listing-card__category">{categoryName(category, language)}</span>
          )}
          <h3 className="listing-card__title" lang={langOf(listing.title_ne, language)}>
            {titleOf(listing, language)}
          </h3>

          {/* The date is in the poster for sighted users; a screen reader gets
              it here, where it reads as part of the sentence. */}
          <p className="listing-card__when">
            <span className="visually-hidden">{`${weekday} ${day} ${month}, `}</span>
            {startTime(listing, language)}
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
