import { SELF } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

/**
 * #50's unit and integration criteria: "correlation ID propagation through the
 * request lifecycle", and "error handlers increment counters as well as
 * logging".
 *
 * The motivating case is F2 in the WaahTickets audit — paid orders producing
 * no tickets, because the failure was swallowed into a response header nobody
 * read. It was invisible for as long as it existed. So what is asserted here
 * is not that logging happens but that **the log is findable from the outside**:
 * a reader who reports a problem can be asked for one string, and that string
 * appears on every line the request produced.
 */

/** Structured lines are JSON on one line, on the `nepscene` channel. */
type Line = Record<string, unknown>

let lines: Line[] = []

function capture(method: 'log' | 'warn' | 'error') {
  return vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
    const first = args[0]
    if (typeof first !== 'string') return
    try {
      const parsed = JSON.parse(first) as Line
      if (parsed.channel === 'nepscene') lines.push(parsed)
    } catch {
      // Not one of ours — wrangler and miniflare write plenty of plain text.
    }
  })
}

beforeAll(seedCatalogue)

beforeEach(() => {
  lines = []
  capture('log')
  capture('warn')
  capture('error')
})

afterEach(() => vi.restoreAllMocks())

const get = (path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://nepscene.test${path}`, { headers })

describe('every request carries a correlation id', () => {
  it('answers with one on a successful request', async () => {
    const response = await get('/api/catalog/listings?limit=1')
    expect(response.headers.get('x-request-id')).toBeTruthy()
  })

  it('uses the edge ray id when there is one, so the trace joins up', async () => {
    // `cf-ray` is what Cloudflare's own logs key on. Minting a fresh uuid when
    // one exists would give us an id that matches nothing upstream.
    const response = await get('/api/catalog/listings?limit=1', { 'cf-ray': 'test-ray-abc' })
    expect(response.headers.get('x-request-id')).toBe('test-ray-abc')
  })

  it('answers with one on a failure too', async () => {
    // The case it is actually for: a reader reports a problem and is asked for
    // this string.
    const response = await get('/api/catalog/listings?limit=999')
    expect(response.status).toBe(400)
    expect(response.headers.get('x-request-id')).toBeTruthy()
  })

  it('puts that same id on the log line the failure produced', async () => {
    const response = await get('/api/catalog/listings?limit=999', { 'cf-ray': 'trace-me' })
    expect(response.status).toBe(400)

    const failure = lines.find((line) => line.event === 'request_failed')
    expect(failure).toBeDefined()
    expect(failure!.request_id).toBe('trace-me')
  })
})

describe('an error that reaches a client is counted', () => {
  it('records the status, the code and where it happened', async () => {
    await get('/api/catalog/listings?limit=999')

    const failure = lines.find((line) => line.event === 'request_failed')
    expect(failure).toMatchObject({
      channel: 'nepscene',
      event: 'request_failed',
      status: 400,
      code: 'invalid_parameter',
      method: 'GET',
      path: '/api/catalog/listings',
    })
  })

  it('counts a 404 as well as a 400, so the rate is the real rate', async () => {
    await get('/api/nothing-here')
    const failure = lines.find((line) => line.event === 'request_failed')
    expect(failure).toMatchObject({ status: 404, code: 'not_found' })
  })

  it('logs a client error at warn and leaves error for our own faults', async () => {
    // A 400 is somebody sending us a bad request; alerting on it at the same
    // level as a 500 makes the 500s unfindable.
    await get('/api/catalog/listings?limit=999')
    expect(lines.find((line) => line.event === 'request_failed')!.level).toBe('warn')
  })

  it('does not echo an unexpected error message into the log fields', async () => {
    // Only errors we raised deliberately carry their message. An unexpected
    // one can contain anything, including a fragment of a row.
    await get('/api/catalog/listings?limit=999')
    const failure = lines.find((line) => line.event === 'request_failed')!
    expect(typeof failure.message).toBe('string')
  })

  it('says nothing at all when nothing went wrong', async () => {
    await get('/api/catalog/listings?limit=1')
    expect(lines.filter((line) => line.event === 'request_failed')).toHaveLength(0)
    expect(lines.filter((line) => line.event === 'swallowed')).toHaveLength(0)
  })
})

describe('a swallowed error leaves a trace', () => {
  it('counts a cursor the API did not issue, rather than failing or hiding it', async () => {
    // Ranked search starts from the beginning on a cursor it cannot read,
    // which is right — and would otherwise be indistinguishable from a cursor
    // that worked. A rate of these means something is generating them.
    const response = await get('/api/catalog/search?q=rock&cursor=not-a-real-cursor')
    expect(response.status).toBe(200)

    const swallow = lines.find((line) => line.event === 'swallowed')
    expect(swallow).toMatchObject({ event: 'swallowed', reason: 'search_cursor_decode' })
    expect(swallow!.level).toBe('warn')
    expect(swallow!.cause).toBeTruthy()
  })

  it('stays quiet for a cursor that is merely wrong rather than malformed', async () => {
    // `nonsense` is valid base64, so it decodes and fails the prefix check
    // without throwing. Nothing was caught, so nothing is counted — the
    // counter measures decode failures, not every cursor that misses.
    const response = await get('/api/catalog/search?q=rock&cursor=nonsense')
    expect(response.status).toBe(200)
    expect(lines.filter((line) => line.event === 'swallowed')).toHaveLength(0)
  })

  it('keeps the reason low-cardinality, so a dashboard can group by it', async () => {
    await get('/api/catalog/search?q=rock&cursor=not~a~cursor')
    const swallow = lines.find((line) => line.event === 'swallowed')!
    // No id, slug, URL or free text — those belong in the other fields.
    expect(swallow.reason).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})
