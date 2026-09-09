import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ListingInput } from '../../api/author/validate'
import { createListing, updateListing, AuthorError } from '../lib/author'
import { browserStorage, clearDraft, saveDraft, type DraftStorage } from './draftStore'

/**
 * Autosave (#30), and the addition worth making to the ported wizard: losing a
 * half-written event to a closed tab is the kind of thing that stops someone
 * contributing a second time.
 *
 * Two layers, because they fail differently:
 *
 *   local   synchronous, every change, survives a crash mid-request
 *   server  debounced, authoritative, survives a different device
 *
 * The debounce is what makes the server layer affordable — a PATCH per
 * keystroke is a write per keystroke — and the local layer is what makes the
 * debounce safe.
 */
const DEBOUNCE_MS = 1500

export type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; at: string }
  | { status: 'error'; message: string }

type Options = {
  listing: ListingInput
  step: string
  /** Present in edit mode, and set by the first successful save in create mode. */
  listingId: string | null
  onCreated: (id: string) => void
  enabled: boolean
  storage?: DraftStorage
}

export function useDraft({ listing, step, listingId, onCreated, enabled, storage }: Options) {
  const [state, setState] = useState<SaveState>({ status: 'idle' })
  const store = useMemo(() => storage ?? browserStorage(), [storage])

  // Refs, not state: the debounce timer reads these when it fires, and closing
  // over the render's values instead would save whatever was on screen 1.5
  // seconds ago rather than what is there now.
  const latest = useRef({ listing, step, listingId })
  latest.current = { listing, step, listingId }

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Guards against two saves overlapping and creating the listing twice. */
  const inFlight = useRef(false)
  const pending = useRef(false)

  const flush = useCallback(async () => {
    if (!enabled) return
    if (inFlight.current) {
      // A save is already running; remember that more has changed since.
      pending.current = true
      return
    }

    inFlight.current = true
    setState({ status: 'saving' })

    try {
      const { listing: current, listingId: id } = latest.current
      if (id) {
        const { updated_at } = await updateListing(id, current)
        setState({ status: 'saved', at: updated_at })
      } else {
        const created = await createListing(current)
        // The id has to reach the caller before the next save runs, or the
        // second autosave creates a second listing.
        latest.current.listingId = created.id
        onCreated(created.id)
        setState({ status: 'saved', at: new Date().toISOString() })
      }
      // The server has it now, so the local copy has done its job. Both keys
      // go: the one this draft was written under before it had an id, and the
      // one it has been written under since. Leaving either is a stale recovery
      // prompt on the next visit.
      clearDraft(store, null)
      if (latest.current.listingId) clearDraft(store, latest.current.listingId)
    } catch (error) {
      const message = error instanceof AuthorError
        ? error.message
        : 'Could not reach the server — your work is saved on this device'
      setState({ status: 'error', message })
    } finally {
      inFlight.current = false
      if (pending.current) {
        pending.current = false
        void flush()
      }
    }
  }, [enabled, onCreated, store])

  // The local write is synchronous and unconditional; the server write waits.
  useEffect(() => {
    if (!enabled) return
    saveDraft(store, { id: listingId, listing, step, savedAt: new Date().toISOString() })

    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), DEBOUNCE_MS)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [listing, step, listingId, enabled, store, flush])

  /**
   * A tab going away is the last chance to save the debounced changes. Both
   * events are listened for because neither is enough alone: `beforeunload`
   * does not fire on mobile Safari when the app is swiped away, and
   * `visibilitychange` fires on every tab switch, most of which are not an
   * exit. `pagehide` always means the page is going, so it flushes
   * unconditionally; `visibilitychange` only when actually hidden. The
   * in-flight guard makes the overlap harmless.
   */
  useEffect(() => {
    if (!enabled) return
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flush()
    }
    const onPageHide = () => void flush()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [enabled, flush])

  return { state, saveNow: flush }
}
