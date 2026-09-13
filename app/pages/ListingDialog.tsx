import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { fetchListing } from '../lib/client'
import { useResource } from '../lib/useResource'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useT } from '../i18n'
import { Alert, Button } from '../components/primitives'
import { Link, closeOverlay, overlayOpener } from '../router'
import { ListingContent, ListingSkeleton } from './Listing'

/**
 * A listing opened over the page it was found on.
 *
 * WaahTickets opened every event in a modal and had no page behind it; #43
 * built the page and sent every card there. This is the middle: the card
 * opens a dialog so a reader scanning a row keeps their place, the address
 * bar says `/listings/<slug>` so the link they copy is the page's, and Back —
 * or Escape, or the scrim — returns them to the row. The router owns that
 * (`navigate(…, { overlay: true })`); this only draws what it says is open.
 *
 * The content is the page's own `ListingContent`, not a summary of it: a
 * dialog that showed less than the page would send people to the page to
 * find out what, and then the dialog is a step rather than a shortcut.
 */
export function ListingDialog({ slug }: { slug: string }) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const { data, loading, missing, error } = useResource(
    (signal) => fetchListing(slug, signal), [slug], `/listings/${slug}`,
  )

  useFocusTrap(dialogRef, true, closeOverlay)

  // After the trap's own restore, so this wins where the trap had nothing to
  // restore to (see `overlayOpener`). Skipped when the card is gone — a link
  // inside the dialog replaced the page — and the new page takes focus itself.
  useEffect(() => () => {
    const card = overlayOpener()
    if (card?.isConnected) card.focus()
  }, [])

  // The page behind must not scroll along with the dialog. The shell does the
  // same for its menu, and for the same reason.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  // Opening a related listing from inside the dialog changes the slug under
  // the same dialog; a reader expects to start at its top, not where they were.
  useEffect(() => { dialogRef.current?.scrollTo(0, 0) }, [slug])

  const failed = missing || (error && !data)

  return createPortal(
    <div
      className="modal__scrim listing-dialog__scrim"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeOverlay() }}
    >
      <div
        ref={dialogRef}
        className="modal modal--lg listing-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={data ? titleId : undefined}
        aria-label={data ? undefined : t(missing ? 'listing.notFound' : loading ? 'common.loading' : 'common.error')}
        aria-busy={loading || undefined}
        tabIndex={-1}
      >
        <div className="listing-dialog__bar">
          {/* A plain link, so the reader who wants the page — to bookmark it,
              to read it without the row behind — has it one click away. */}
          <Link className="btn btn--ghost btn--sm" href={`/listings/${slug}`}>{t('listing.openPage')}</Link>
          <Button variant="ghost" size="sm" onClick={closeOverlay} aria-label={t('listing.close')}>✕</Button>
        </div>

        {loading && <ListingSkeleton bare />}

        {failed && (
          <div className="stack">
            <h2>{missing ? t('listing.notFound') : t('common.error')}</h2>
            <Alert tone={missing ? 'info' : 'danger'} title={missing ? t('listing.notFound') : t('common.error')}>
              {missing ? t('listing.notFoundBody') : error?.message}
            </Alert>
          </div>
        )}

        {data && !loading && (
          <article className="listing-page">
            <ListingContent listing={data} level={2} titleId={titleId} />
          </article>
        )}
      </div>
    </div>,
    document.body,
  )
}
