/**
 * What the server already knows (#45).
 *
 * A server-rendered page has, by definition, loaded its data — and a client
 * that then fetched the same thing again would replace a painted page with a
 * spinner and pay a round trip from Kathmandu to do it. So the Worker
 * serialises what it loaded into the document, and `useResource` reads it for
 * its first render instead of fetching.
 *
 * **Keyed by request, not by shape.** The key is the API path the client would
 * otherwise have called, so a page that server-rendered `/venues/purple-haze`
 * cannot accidentally seed the listing page's resource with it. A key that is
 * absent simply means "fetch" — which is what every client-side navigation
 * after the first one does anyway.
 *
 * **Read once.** The payload is the state of the world at render time; after
 * the reader navigates away and back, it is stale and the fetch is right. So
 * each entry is deleted as it is taken.
 */
const GLOBAL_KEY = '__NEPSCENE_PRELOAD__'

export type Preloaded = Record<string, unknown>

type Holder = { [GLOBAL_KEY]?: Preloaded }

/** Injected by the server as a JSON script tag; absent on a client-only load. */
export function takePreloaded<T>(key: string): T | null {
  const holder = globalThis as Holder
  const store = holder[GLOBAL_KEY]
  if (!store || !(key in store)) return null
  const value = store[key] as T
  delete store[key]
  return value
}

/** The server's side of the same contract, so the two cannot disagree. */
export function serialisePreloaded(entries: Preloaded): string {
  // `</script>` inside the JSON would close the tag it is sitting in, and
  // `<!--` opens an HTML comment inside it; both are the standard XSS vectors
  // for inlined JSON and both are escaped rather than stripped, because the
  // value has to survive the round trip unchanged.
  return JSON.stringify(entries)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export const PRELOAD_GLOBAL = GLOBAL_KEY
