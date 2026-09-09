import { useEffect, type ReactNode } from 'react'
import { recordListingEvent } from '../lib/analytics'

/**
 * Counts a view of a listing (#34), and renders whatever the listing page is.
 *
 * It wraps rather than being folded into the page because the page is not
 * built yet — `/listings/:slug` is still a placeholder until #43 — and the
 * counting is worth having before it. A dashboard that shows zeros for its
 * first milestone teaches organizers that the numbers are decoration, and the
 * numbers are the whole reason the dashboard exists.
 *
 * The **click** half of the counter has nowhere to fire from yet: it belongs
 * on the offer link, which is #43's to render. `recordListingEvent` takes it
 * today so that landing is one call rather than a second endpoint.
 */
export function ListingRoute({ slug, children }: { slug: string; children: ReactNode }) {
  useEffect(() => { recordListingEvent(slug, 'view') }, [slug])
  return <>{children}</>
}
