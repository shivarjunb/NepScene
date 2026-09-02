import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('GET /api/health', () => {
  it('answers without touching any dependency', async () => {
    const response = await SELF.fetch('https://nepscene.test/api/health')
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.status).toBe('ok')
    // A deploy that cannot say which version it is cannot be smoke-tested.
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('GET /api/cache/status', () => {
  it('probes for real rather than reporting that a variable is set', async () => {
    const response = await SELF.fetch('https://nepscene.test/api/cache/status')
    const body = await response.json() as any

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
    // Each probe did a live round trip and reports what it measured — the check
    // WaahTickets did not have while its cache was silently dead for weeks.
    for (const probe of Object.values<any>(body.probes)) {
      expect(probe.ok).toBe(true)
      expect(typeof probe.ms).toBe('number')
    }
    expect(body.probes.d1.detail).toMatch(/listings$/)
  })
})
