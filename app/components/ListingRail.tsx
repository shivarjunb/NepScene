import type { Row } from '../lib/rows'
import { ListingCard, ListingCardSkeleton } from './ListingCard'
import { useT } from '../i18n'
import { Link } from '../router'

/**
 * A rule-based row (#41). The rule is printed under the heading rather than
 * kept in the source: a row called "This weekend" that quietly means something
 * else is how the WaahTickets rails lost people's trust.
 *
 * The rail scrolls horizontally with the keyboard as well as the mouse — it is
 * a focusable region, so a keyboard user can reach the cards further along
 * without tabbing through every one of them.
 */
export function ListingRail({ row }: { row: Row }) {
  const t = useT()
  const empty = row.listings.length === 0

  return (
    <section className="rail" aria-labelledby={`rail-${row.id}`}>
      <div className="rail__head">
        <div>
          <h2 className="rail__title" id={`rail-${row.id}`}>{row.title}</h2>
          <p className="rail__rule">{row.rule}</p>
        </div>
        {!empty && row.href && (
          <Link className="rail__more" href={row.href}>
            {t('discover.seeAll')}<span className="visually-hidden"> {row.title}</span>
          </Link>
        )}
      </div>

      {empty ? (
        // The row stays. A row that vanishes when its rule matches nothing
        // makes the page a different shape every visit and hides the fact
        // that the rule ran at all.
        <p className="rail__empty">{row.empty}</p>
      ) : (
        <ul className="rail__track" tabIndex={0} role="list"
            aria-label={`${row.title}, scrollable`}>
          {row.listings.map((listing) => (
            <li key={listing.id}>
              <ListingCard listing={listing} layout="row" />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function ListingRailSkeleton() {
  return (
    <section className="rail">
      <div className="rail__head">
        <div className="skeleton" style={{ width: '9rem', height: '1.5rem' }} />
      </div>
      <ul className="rail__track" role="list">
        {[0, 1, 2, 3].map((index) => (
          <li key={index}><ListingCardSkeleton layout="row" /></li>
        ))}
      </ul>
    </section>
  )
}
