import { Hono } from 'hono'
import type { Env } from '../env'
import pkg from '../../package.json'
import { openApiDocument } from '../openapi'

/**
 * "The env var is set" is not a health check (docs/ARCHITECTURE.md, rule 2).
 * WaahTickets reported its cache as configured and healthy for an unknown
 * period while the database behind it did not exist. Every probe here does a
 * real round trip and reports measured latency.
 */
export const healthRoutes = new Hono<{ Bindings: Env }>()

const PROBE_TIMEOUT_MS = 1000

type Probe = { ok: boolean; ms: number; detail?: string }

async function probe(run: () => Promise<string | undefined>): Promise<Probe> {
  const started = Date.now()
  try {
    const detail = await withTimeout(run(), PROBE_TIMEOUT_MS)
    return { ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) }
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      detail: err instanceof Error ? err.message : 'failed',
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ])
}

// No I/O at all — this is the baseline the other numbers are read against.
healthRoutes.get('/health', (c) =>
  c.json({
    status: 'ok',
    version: pkg.version,
    environment: c.env.ENVIRONMENT,
    time: new Date().toISOString(),
  }),
)

// The contract, served from the same place it is enforced (#23).
healthRoutes.get('/openapi.json', (c) =>
  c.json(openApiDocument, 200, { 'cache-control': 'public, max-age=300' }),
)

healthRoutes.get('/cache/status', async (c) => {
  const token = crypto.randomUUID()
  const origin = new URL(c.req.url).origin

  const cacheProbe = await probe(async () => {
    const key = new Request(`${origin}/__probe/${token}`)
    await caches.default.put(
      key,
      new Response(token, { headers: { 'cache-control': 'max-age=60' } }),
    )
    const hit = await caches.default.match(key)
    if (!hit) throw new Error('probe key written but not readable')
    const value = await hit.text()
    if (value !== token) throw new Error('probe key read back wrong value')
    c.executionCtx.waitUntil(caches.default.delete(key))
    return 'read/write verified'
  })

  const kvProbe = await probe(async () => {
    await c.env.SETTINGS.put(`probe:${token}`, token, { expirationTtl: 60 })
    const value = await c.env.SETTINGS.get(`probe:${token}`)
    c.executionCtx.waitUntil(c.env.SETTINGS.delete(`probe:${token}`))
    // KV is eventually consistent; a fresh read may legitimately miss.
    return value === token ? 'read/write verified' : 'write accepted, read not yet consistent'
  })

  const dbProbe = await probe(async () => {
    const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first<{ n: number }>()
    return `${row?.n ?? 0} listings`
  })

  const probes = { cache: cacheProbe, kv: kvProbe, d1: dbProbe }
  // The cache and KV are optional on the read path: their failure degrades to
  // direct D1 reads, so it is 'degraded', not 'down'. Only D1 is fatal.
  const status = !dbProbe.ok ? 'down' : cacheProbe.ok && kvProbe.ok ? 'ok' : 'degraded'

  return c.json({ status, environment: c.env.ENVIRONMENT, probes }, status === 'down' ? 503 : 200)
})
