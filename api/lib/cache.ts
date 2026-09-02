import type { Context } from 'hono'
import type { Env } from '../env'

/**
 * Catalog responses are cached in the colo that served them (`caches.default`),
 * never in an external cache service. WaahTickets' hosted Redis added ~1.7s to
 * every request while never once hitting, and even a healthy external cache is
 * a full internet round trip from Kathmandu (docs/ARCHITECTURE.md, rule 1).
 *
 * Freshness is short TTL plus a version stamp: publishing bumps a counter in
 * KV, which changes every cache key at once. Cache API entries cannot be purged
 * across colos, so the key has to carry the version rather than the entry being
 * deleted.
 */
export const CATALOG_TTL_SECONDS = 60
export const REFERENCE_TTL_SECONDS = 300 // categories change about never

const VERSION_KEY = 'catalog:version'
const VERSION_MEMO_MS = 30_000

let memo: { value: string; at: number } | null = null

export async function catalogVersion(env: Env): Promise<string> {
  const now = Date.now()
  if (memo && now - memo.at < VERSION_MEMO_MS) return memo.value
  let value = '1'
  try {
    // cacheTtl keeps this in the colo's KV cache; the memo above keeps it out
    // of the request path entirely for 30s at a time.
    value = (await env.SETTINGS.get(VERSION_KEY, { cacheTtl: 60 })) ?? '1'
  } catch {
    // KV is optional on the read path. A version we cannot read degrades to
    // serving the previous version's cache for up to one TTL — never an error.
  }
  memo = { value, at: now }
  return value
}

/** Called by author writes on publish/unpublish. Invalidates every catalog key. */
export async function bumpCatalogVersion(env: Env): Promise<void> {
  const current = Number(await catalogVersion(env)) || 1
  const next = String(current + 1)
  await env.SETTINGS.put(VERSION_KEY, next)
  memo = { value: next, at: Date.now() }
}

/**
 * Cache keys are canonical: parameters not in `params` are dropped and the rest
 * are sorted, so `?limit=20&category=music` and `?category=music&limit=20` are
 * one entry and a crawler appending tracking parameters cannot shard the cache.
 */
export function canonicalCacheKey(url: URL, params: readonly string[], version: string): Request {
  const key = new URL(url.origin + url.pathname)
  for (const name of [...params].sort()) {
    const value = url.searchParams.get(name)
    if (value !== null && value !== '') key.searchParams.set(name, value)
  }
  key.searchParams.set('v', version)
  return new Request(key.toString(), { method: 'GET' })
}

export type EdgeCacheOptions = {
  ttlSeconds?: number
  /** Query parameters that are part of the identity of the response. */
  params?: readonly string[]
}

export async function withEdgeCache(
  c: Context<{ Bindings: Env }>,
  options: EdgeCacheOptions,
  produce: () => Promise<Response>,
): Promise<Response> {
  const ttl = options.ttlSeconds ?? CATALOG_TTL_SECONDS
  const version = await catalogVersion(c.env)
  const key = canonicalCacheKey(new URL(c.req.url), options.params ?? [], version)
  const cache = caches.default

  const hit = await cache.match(key)
  if (hit) {
    const response = new Response(hit.body, hit)
    response.headers.set('x-cache', 'HIT')
    return response
  }

  const fresh = await produce()
  if (fresh.status === 200) {
    fresh.headers.set('cache-control', `public, max-age=${ttl}, s-maxage=${ttl}`)
    c.executionCtx.waitUntil(cache.put(key, fresh.clone()))
  }
  fresh.headers.set('x-cache', 'MISS')
  return fresh
}
