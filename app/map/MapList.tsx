import type { VenueGroup } from './venueGrouping'
import type { MapPin } from './markers'

/**
 * The map's equivalent list (#40).
 *
 * A map is an inherently visual interface and discovery is this product's
 * whole function, so if pins are the only way to find out what is on, a
 * screen-reader user is excluded from the point of NepScene. The answer is
 * not to make a canvas of tiles navigable — it is to guarantee an equivalent
 * path that is genuinely equivalent.
 *
 * "Equivalent" is a claim with teeth, and it is why this takes `groups`
 * rather than fetching for itself. The list and the map render the same array,
 * built by the same viewport query, cut by the same distance filter, sorted by
 * the same rules. There is no second code path that could return a different
 * set, which is what `tests/unit/mapList.test.ts` asserts and what a list that
 * fetched its own rows could never promise.
 *
 * It is also the failure path: when the Maps API is blocked, rate-limited or
 * simply slow, this is what the page shows, and it is a working discovery
 * surface rather than an apology.
 */

export function MapList({ groups, onOpen, emptyLabel, heading }: {
  groups: VenueGroup[]
  onOpen: (slug: string) => void
  /** What "nothing here" means right now — filtered out, or nothing on. */
  emptyLabel: string
  /**
   * The list's own heading (#49).
   *
   * Not decoration. Without it the venue names below were the first headings
   * under the page's `h1`, which made the map page run h1 → h3 and gave a
   * screen-reader user navigating by heading no way to tell where the list
   * started. It is visually hidden because the surface it sits on already
   * announces itself to anyone who can see it.
   */
  heading: string
}) {
  if (groups.length === 0) {
    return (
      <section aria-label={heading}>
        <p className="map-list__empty">{emptyLabel}</p>
      </section>
    )
  }

  return (
    <section className="map-list__section" aria-labelledby="map-list-heading">
      <h2 id="map-list-heading" className="visually-hidden">{heading}</h2>
      <ul className="map-list">
      {groups.map((group) => (
        <li key={group.key} className="map-list__venue">
          {/* The venue is a heading, not a row: the listings under it are its
              content, and a screen reader's heading navigation is the fastest
              way through a list of places. */}
          <h3 className="map-list__place">
            <span
              className="map-list__dot"
              style={{ '--pin-color': group.primary.pin.color } as React.CSSProperties}
              aria-hidden="true"
            />
            {group.primary.popup.venue ?? group.primary.popup.title}
            {group.count > 1 && (
              <span className="map-list__count"> · {group.count} listings</span>
            )}
          </h3>
          <ul className="map-list__listings">
            {group.pins.map((pin) => (
              <li key={pin.id}>
                <Row pin={pin} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </li>
      ))}
      </ul>
    </section>
  )
}

function Row({ pin, onOpen }: { pin: MapPin; onOpen: (slug: string) => void }) {
  return (
    <button type="button" className="map-list__row" onClick={() => onOpen(pin.slug)}>
      <span className="map-list__chip" aria-hidden="true">{pin.dateChip}</span>
      <span className="map-list__body">
        <span className="map-list__title">{pin.popup.title || 'Untitled listing'}</span>
        <span className="map-list__meta">
          {pin.rank.live && <span className="map-list__live">Live now</span>}
          {/* The chip's date said this already but only to a sighted reader —
              it is `aria-hidden` — so the sentence carries it for everyone
              else. */}
          {pin.popup.when && <span>{pin.popup.when}</span>}
          {pin.popup.category && <span>{pin.popup.category}</span>}
        </span>
      </span>
    </button>
  )
}
