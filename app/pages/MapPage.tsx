import { NepalMap } from '../map/NepalMap'
import { navigate } from '../router'

/**
 * `/map` (#36).
 *
 * Thin on purpose. The map owns its own data, its own viewport and its own
 * empty states, so the page's whole job is to give it a heading and somewhere
 * for a popup to send the reader.
 */
export function MapPage() {
  return (
    <div className="layout stack">
      <header className="stack stack--tight">
        <h1>What’s on, on the map</h1>
        <p className="text-muted">
          Pins are coloured by category. Drag to look around — listings load for
          wherever you are looking.
        </p>
      </header>

      <NepalMap onOpen={(slug) => navigate(`/listings/${slug}`)} />
    </div>
  )
}
