import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from '../../api/lib/cursor'
import { ApiError } from '../../api/lib/http'

describe('cursor', () => {
  const cursor = { startsAt: '2026-09-10T12:00:00.000Z', id: 'lst_abc' }

  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('is opaque — no readable payload in the token', () => {
    expect(encodeCursor(cursor)).not.toContain('lst_abc')
  })

  it('is url-safe', () => {
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('treats undefined as "first page"', () => {
    expect(decodeCursor(undefined)).toBeUndefined()
  })

  it('rejects a cursor it did not issue', () => {
    expect(() => decodeCursor('not-a-cursor!!')).toThrow(ApiError)
    expect(() => decodeCursor(btoa('no-separator'))).toThrow(ApiError)
  })
})
