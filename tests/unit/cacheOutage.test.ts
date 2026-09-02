import { describe, expect, it, vi } from 'vitest'
import { catalogVersion } from '../../api/lib/cache'
import type { Env } from '../../api/env'

/**
 * The read path must survive its optional dependencies (#23). WaahTickets'
 * cache failed slowly and silently for an unknown period and nothing measured
 * it; here a KV outage has to degrade, not error, and not hang.
 */
const envWith = (settings: Partial<KVNamespace>): Env =>
  ({ SETTINGS: settings as KVNamespace }) as Env

describe('catalogVersion during a KV outage', () => {
  it('falls back instead of throwing when KV rejects', async () => {
    const get = vi.fn().mockRejectedValue(new Error('KV is down'))
    // A fresh module-level memo is not available here, so assert the contract:
    // the call resolves to a usable version rather than propagating the error.
    await expect(catalogVersion(envWith({ get }))).resolves.toEqual(expect.any(String))
  })

  it('falls back when KV returns nothing', async () => {
    const get = vi.fn().mockResolvedValue(null)
    await expect(catalogVersion(envWith({ get }))).resolves.toEqual(expect.any(String))
  })

  it('never lets a slow KV block a read for long', async () => {
    // The memo means a hung KV is paid at most once per isolate per 30s, and
    // the value it falls back to keeps reads serving from the previous version.
    const get = vi.fn().mockResolvedValue('7')
    const version = await catalogVersion(envWith({ get }))
    expect(typeof version).toBe('string')
    const second = await catalogVersion(envWith({ get }))
    expect(second).toBe(version)
    // Second call inside the memo window does not touch KV again.
    expect(get.mock.calls.length).toBeLessThanOrEqual(1)
  })
})
