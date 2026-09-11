import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRequestId, logEvent, requestFailed, setRequestId, swallowed,
} from '../../api/lib/observability'

/**
 * #50's unit criteria, on the module rather than through HTTP: correlation id
 * propagation, and that error handlers count as well as log.
 *
 * The shape of a line is a contract, not an implementation detail — a
 * dashboard groups by `event` and `reason`, and an alert fires on `level`. So
 * the fields are asserted by name here, and a rename has to be a deliberate
 * act rather than a refactor nobody noticed.
 */
const lines: Record<string, unknown>[] = []

const capture = (method: 'log' | 'warn' | 'error') =>
  vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
    lines.push(JSON.parse(String(args[0])) as Record<string, unknown>)
  })

beforeEach(() => {
  lines.length = 0
  capture('log')
  capture('warn')
  capture('error')
})

afterEach(() => {
  setRequestId(null)
  vi.restoreAllMocks()
})

describe('the correlation id', () => {
  it('is null until a request sets one', () => {
    expect(getRequestId()).toBeNull()
  })

  it('is readable once set, and clearable afterwards', () => {
    setRequestId('ray-1')
    expect(getRequestId()).toBe('ray-1')
    setRequestId(null)
    expect(getRequestId()).toBeNull()
  })

  it('lands on every line logged while it is set', () => {
    setRequestId('ray-2')
    logEvent('info', 'a')
    swallowed('b', new Error('x'))
    requestFailed(500, 'c')
    expect(lines.map((line) => line.request_id)).toEqual(['ray-2', 'ray-2', 'ray-2'])
  })

  it('is null on a line logged outside a request, rather than stale', () => {
    // The failure this guards: a line from a cron or a module-load path
    // inheriting the last request's id and pointing at the wrong trace.
    setRequestId('ray-3')
    setRequestId(null)
    logEvent('info', 'later')
    expect(lines[0]!.request_id).toBeNull()
  })
})

describe('a line is one JSON object with a stable shape', () => {
  it('carries the channel, so ours are separable from the runtime\'s', () => {
    logEvent('info', 'thing')
    expect(lines[0]).toMatchObject({ channel: 'nepscene', event: 'thing', level: 'info' })
  })

  it('carries a timestamp', () => {
    logEvent('info', 'thing')
    expect(Date.parse(String(lines[0]!.at))).not.toBeNaN()
  })

  it('merges the fields it was given', () => {
    logEvent('warn', 'thing', { path: '/x', count: 2, ok: false, missing: null })
    expect(lines[0]).toMatchObject({ path: '/x', count: 2, ok: false, missing: null })
  })

  it('writes one line, not a pretty-printed object', () => {
    // A multi-line log entry is several entries to every pipeline that reads
    // them, and the last one is the only one that parses.
    const spy = vi.spyOn(console, 'log')
    logEvent('info', 'thing', { a: 1 })
    expect(String(spy.mock.calls[0]![0])).not.toContain('\n')
  })

  it('sends each level to the matching console method', () => {
    // Workers Logs keys severity off this, and an error logged at `log` is an
    // error no alert will ever see.
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    logEvent('info', 'a')
    logEvent('warn', 'b')
    logEvent('error', 'c')
    expect(log).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe('a swallowed error', () => {
  it('records the reason and the cause at warn', () => {
    swallowed('kv_read', new Error('boom'))
    expect(lines[0]).toMatchObject({
      event: 'swallowed', reason: 'kv_read', cause: 'boom', level: 'warn',
    })
  })

  it('handles a thrown non-Error without losing it', () => {
    // `throw 'string'` is legal and does happen, usually from a library.
    swallowed('odd', 'just a string')
    expect(lines[0]!.cause).toBe('just a string')
  })

  it('records the message, not the stack', () => {
    // A stack from a minified Worker bundle is noise, and `reason` is what
    // actually identifies the site.
    swallowed('kv_read', new Error('boom'))
    expect(String(lines[0]!.cause)).toBe('boom')
    expect(String(lines[0]!.cause)).not.toContain('at ')
  })

  it('carries extra fields beside the reason', () => {
    swallowed('kv_read', new Error('boom'), { key_prefix: 'rl' })
    expect(lines[0]).toMatchObject({ reason: 'kv_read', key_prefix: 'rl' })
  })
})

describe('a failed request', () => {
  it('is a warning when it was the client\'s fault', () => {
    requestFailed(400, 'invalid_parameter')
    expect(lines[0]).toMatchObject({ event: 'request_failed', status: 400, level: 'warn' })
  })

  it('is an error when it was ours', () => {
    // Alerting on 400s at the same level as 500s makes the 500s unfindable.
    requestFailed(500, 'internal_error')
    expect(lines[0]!.level).toBe('error')
  })

  it('treats every 5xx as ours and every 4xx as theirs', () => {
    for (const [status, level] of [[404, 'warn'], [429, 'warn'], [500, 'error'], [503, 'error']] as const) {
      lines.length = 0
      requestFailed(status, 'x')
      expect(lines[0]!.level, String(status)).toBe(level)
    }
  })
})
