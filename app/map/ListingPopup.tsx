import type { PopupConfig, PopupFieldKey } from '../../api/author/popupConfig'
import type { PinAppearance } from '../../api/catalog/types'

/**
 * The card that opens when somebody taps a pin (#32, and #36 mounts this on
 * the public map).
 *
 * It lives in `app/map/` rather than in `app/author/` on purpose. The
 * acceptance criterion is that the wizard's preview is accurate *against the
 * real map component*, and the only way to make that true rather than
 * approximately true is for there to be one component. WaahTickets had two —
 * a preview that assembled an HTML string and a map that drew a plain circle —
 * and they had drifted apart before anybody noticed.
 *
 * Ported from `EventMapPopup` with the commerce coupling removed: no
 * `priceFrom`, no `isSoldOut`, no sponsorship. What survives of the offer is
 * the seam NepScene renders and never computes (docs/SCOPE.md) — a link and,
 * if the resolver gave one, a "from" price it treats as a string it was told.
 */

export type PopupListing = {
  slug: string
  title: string
  pin: PinAppearance
  venue: string | null
  when: string | null
  category: string | null
  summary: string | null
  /** Already formatted by whoever knows the currency; never computed here. */
  offer: { label: string; url: string | null } | null
}

const VALUE: Record<PopupFieldKey, (listing: PopupListing) => string | null> = {
  venue: (listing) => listing.venue,
  when: (listing) => listing.when,
  category: (listing) => listing.category,
  summary: (listing) => listing.summary,
  offer: (listing) => listing.offer?.label ?? null,
}

export function ListingPopup({ listing, config, onOpen }: {
  listing: PopupListing
  config: PopupConfig
  /** Absent in the wizard preview, where there is nowhere to go. */
  onOpen?: (slug: string) => void
}) {
  // A hidden field and a field with nothing in it are the same thing to a
  // reader. Deciding both here keeps every caller from having to.
  const rows = config.fields
    .filter((field) => field.visible)
    .map((field) => ({ ...field, value: VALUE[field.field](listing) }))
    .filter((field): field is typeof field & { value: string } => Boolean(field.value))

  return (
    <article className="pin-card" style={{ '--pin-color': listing.pin.color } as React.CSSProperties}>
      <header className="pin-card__head">
        <h3 className="pin-card__title">{listing.title || 'Untitled listing'}</h3>
      </header>

      {rows.length > 0 && (
        <dl className="pin-card__rows">
          {rows.map((row) => (
            <div key={row.field} className="pin-card__row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {onOpen && (
        <button type="button" className="pin-card__open" onClick={() => onOpen(listing.slug)}>
          See the listing
        </button>
      )}
    </article>
  )
}
