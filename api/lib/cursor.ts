import { badRequest } from './http'

/**
 * Keyset cursor over (starts_at, id) — the same tuple the feed is ordered and
 * indexed by. Opaque on purpose: the encoding is ours to change, and a client
 * that parses it is a client we cannot change it for.
 */
export type Cursor = { startsAt: string; id: string }

export function encodeCursor(cursor: Cursor): string {
  return base64UrlEncode(`${cursor.startsAt}|${cursor.id}`)
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined
  let decoded: string
  try {
    decoded = base64UrlDecode(raw)
  } catch {
    throw badRequest('invalid_cursor', 'cursor is not a cursor this API issued')
  }
  const separator = decoded.indexOf('|')
  if (separator < 1 || separator === decoded.length - 1) {
    throw badRequest('invalid_cursor', 'cursor is not a cursor this API issued')
  }
  return { startsAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) }
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
