import { useEffect, useRef, useState } from 'react'
import { ApiError } from './client'
import { usePreloaded } from './preloadContext'

/**
 * One fetch, tied to the life of the component (#43, #44).
 *
 * Five pages needed the same fifteen lines — request, abort on unmount, ignore
 * the response of a request that has been superseded, keep the error apart
 * from the data — and five copies of that is five places for the abort to be
 * forgotten. Forgetting it is not a leak so much as a correctness bug: a
 * reader who taps two listings quickly gets whichever response happens to
 * arrive last, which is not necessarily the one they are looking at.
 *
 * Deliberately not a cache. Every page here is already served from the edge
 * cache with a short TTL, so a client-side one would add a second staleness
 * story on top of a solved problem.
 *
 * `preloadKey` is the exception, and it is not a cache either: it is the data
 * the server rendered this very page from (#45), taken once so the first paint
 * needs no request. Without it a server-rendered page would replace itself
 * with a spinner the moment React woke up.
 */
export type Resource<T> = {
  data: T | null
  error: Error | null
  /** True until the first response settles, and again on every re-run. */
  loading: boolean
  /** 404 specifically, because a missing page is not a broken one. */
  missing: boolean
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  /** The API path the server may already have loaded this from. */
  preloadKey?: string,
): Resource<T> {
  // Read before the state, because it is a hook: the server has this request's
  // data in context, and the browser takes it from the injected payload once.
  const preloaded = usePreloaded<T>(preloadKey)

  const [state, setState] = useState<Resource<T>>(() =>
    preloaded
      ? { data: preloaded, error: null, loading: false, missing: false }
      : { data: null, error: null, loading: true, missing: false })

  /**
   * Exactly one effect run is skipped: the first, and only when the server
   * supplied the data for it. Anything later — a filter changed, the reader
   * navigated back — has to fetch, so this is a one-shot flag rather than a
   * check on whether data happens to be present.
   */
  const servedByTheServer = useRef(state.data !== null)

  useEffect(() => {
    if (servedByTheServer.current) {
      servedByTheServer.current = false
      return
    }

    const controller = new AbortController()
    setState({ data: null, error: null, loading: true, missing: false })

    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ data, error: null, loading: false, missing: false })
        }
      })
      .catch((cause: Error) => {
        // An abort is the expected end of a superseded request, not a failure
        // to report — rendering it would flash an error on every navigation.
        if (controller.signal.aborted) return
        setState({
          data: null,
          error: cause,
          loading: false,
          missing: cause instanceof ApiError && cause.status === 404,
        })
      })

    return () => controller.abort()
    // `deps` is the caller's dependency list, passed through: this hook cannot
    // know what `load` closes over, and the alternative — requiring a
    // useCallback at every call site — moves the same problem one line up.
  }, deps)

  return state
}
