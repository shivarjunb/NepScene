import type { VenueGroup } from './venueGrouping'
import type { MapPin } from './markers'

/**
 * The picker behind a grouped pin (#37).
 *
 * A venue with eight listings is one pin, and one pin cannot open eight
 * popups. WaahTickets solved this by opening the *primary* listing's card and
 * putting the rest behind a small "+7 more" affordance that most people never
 * found — which meant the other seven were, in practice, not on the map.
 *
 * So the stack is the first thing a grouped pin opens, not a second step
 * inside a card. It is a list, in the tuned order (`compareInStack`), with the
 * date and category on every row so it can be scanned rather than read.
 */

export function VenueStack({ group, onSelect, onClose, venueName }: {
  group: VenueGroup
  /** Show this listing's popup. */
  onSelect: (pin: MapPin) => void
  onClose: () => void
  /** From the primary's popup, which is where the formatted venue line lives. */
  venueName: string | null
}) {
  return (
    <article className="venue-stack" aria-label={`Listings at ${venueName ?? 'this place'}`}>
      <header className="venue-stack__head">
        <h3 className="venue-stack__title">{venueName ?? 'This place'}</h3>
        <p className="venue-stack__count">
          {group.count} listing{group.count === 1 ? '' : 's'}
        </p>
        <button
          type="button"
          className="venue-stack__close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </header>

      <ul className="venue-stack__list">
        {group.pins.map((pin) => (
          <li key={pin.id}>
            <button
              type="button"
              className="venue-stack__row"
              onClick={() => onSelect(pin)}
            >
              {/* The chip is the scannable column; the sentence underneath is
                  the same instant spelled out for anyone who needs it. */}
              <span className="venue-stack__chip" aria-hidden="true">{pin.dateChip}</span>
              <span className="venue-stack__body">
                <span className="venue-stack__name">{pin.popup.title || 'Untitled listing'}</span>
                <span className="venue-stack__meta">
                  {pin.rank.live && <span className="venue-stack__live">Live now</span>}
                  {pin.popup.when && <span>{pin.popup.when}</span>}
                  {pin.popup.category && (
                    <span
                      className="venue-stack__category"
                      style={{ '--pin-color': pin.pin.color } as React.CSSProperties}
                    >
                      {pin.popup.category}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </article>
  )
}
