/**
 * PBKDF2-SHA256 via WebCrypto. Workers has no bcrypt or argon2, and pulling a
 * pure-JS implementation onto the sign-in path would cost more CPU than this
 * does. Iteration count follows OWASP's 2023 guidance for PBKDF2-SHA256.
 *
 * Format: pbkdf2$sha256$<iterations>$<salt b64>$<hash b64>. The parameters
 * travel with the hash so they can be raised later without invalidating
 * everyone's password.
 */
const ITERATIONS = 210_000
const KEY_LENGTH_BITS = 256
const SALT_BYTES = 16

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2$sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false
  const iterations = Number(parts[2])
  if (!Number.isInteger(iterations) || iterations < 1000) return false

  const salt = fromBase64(parts[3] ?? '')
  const expected = fromBase64(parts[4] ?? '')
  const actual = await derive(password, salt, iterations)
  return timingSafeEqual(actual, expected)
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_LENGTH_BITS,
  )
  return new Uint8Array(bits)
}

/** Comparison time must not depend on how much of the digest matched. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0))
}

/** Session cookies and email tokens are stored only as their SHA-256. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return toBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
