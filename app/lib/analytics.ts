/**
 * Telling the Worker somebody looked (#34).
 *
 * The counter is a fire-and-forget POST — `keepalive`, no response read, and
 * every failure swallowed. Nothing on the page depends on it, and a visitor
 * reading a listing must never wait on, or be shown, a counter.
 *
 * **One view per listing per browser tab session.** Without this a reload is a
 * view and a back-button is a view, which inflates exactly the number an
 * organizer is being asked to trust. `sessionStorage` rather than
 * `localStorage` is the right granularity: coming back tomorrow *is* another
 * view, and coming back in thirty seconds is not.
 *
 * A click is not deduplicated. Somebody who goes to the ticket page twice
 * clicked twice, and that is the thing being counted.
 */

const SEEN = 'nepscene:seen:'

const quietly = <T>(action: () => T, fallback: T): T => {
  try {
    return action()
  } catch {
    return fallback
  }
}

export function recordListingEvent(slug: string, kind: 'view' | 'click'): void {
  if (!slug) return

  if (kind === 'view') {
    const key = `${SEEN}${slug}`
    if (quietly(() => sessionStorage.getItem(key), null)) return
    quietly(() => sessionStorage.setItem(key, '1'), undefined)
  }

  quietly(() => {
    void fetch(`/api/catalog/listings/${encodeURIComponent(slug)}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
      // Survives the navigation it is usually reporting — a click beacon fired
      // as the page unloads is otherwise cancelled by the browser.
      keepalive: true,
    }).catch(() => {})
  }, undefined)
}
