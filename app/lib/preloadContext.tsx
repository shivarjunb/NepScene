import { createContext, useContext, type ReactNode } from 'react'
import { takePreloaded, type Preloaded } from './preload'

/**
 * How a component reaches the data the server already loaded (#45).
 *
 * **Context, not the global, on the server.** The obvious shortcut is to set
 * `globalThis.__NEPSCENE_PRELOAD__` before rendering and let `takePreloaded`
 * find it — and it would work, until two requests render at once in the same
 * isolate and the second one reads the first one's listing. A Worker serves
 * many requests per isolate; anything per-request that lives on a global is a
 * cross-request bug waiting for traffic.
 *
 * In the browser there is exactly one document and one reader, so the global
 * the server injected is per-request by construction, and taking from it is
 * correct.
 */
const PreloadContext = createContext<Preloaded | null>(null)

export function PreloadProvider({ value, children }: {
  value: Preloaded | null
  children: ReactNode
}) {
  return <PreloadContext.Provider value={value}>{children}</PreloadContext.Provider>
}

/**
 * The data for one request, or null.
 *
 * The server *reads* and the browser *takes*: on the server the map belongs to
 * this request and will be discarded with it, while in the browser the injected
 * payload is the state of the world at render time and is stale the moment the
 * reader navigates away — so it is consumed once and then gone.
 */
export function usePreloaded<T>(key: string | undefined): T | null {
  const fromServer = useContext(PreloadContext)
  if (!key) return null
  if (fromServer) return key in fromServer ? (fromServer[key] as T) : null
  return takePreloaded<T>(key)
}
