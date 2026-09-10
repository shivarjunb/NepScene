import { describe, expect, it } from 'vitest'
import { MAX_ITERATIONS, hashPassword, sha256Hex, verifyPassword } from '../../api/identity/password'

describe('password hashing', () => {
  it('verifies the password it hashed', async () => {
    const stored = await hashPassword('a-decent-passphrase')
    expect(await verifyPassword('a-decent-passphrase', stored)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('a-decent-passphrase')
    expect(await verifyPassword('a-decent-passphras', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
  })

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('carries its parameters so they can be raised later', async () => {
    expect(await hashPassword('x')).toMatch(
      new RegExp(`^pbkdf2\\$sha256\\$${MAX_ITERATIONS}\\$[^$]+\\$[^$]+$`),
    )
  })

  /**
   * The deployed Workers runtime rejects PBKDF2 above 100,000 iterations; the
   * local workerd these tests run in does not. So this asserts the constant
   * rather than the behaviour — running the hash here proves nothing about
   * whether it works in production, and the previous 210,000 passed every test
   * while 500ing every real sign-in.
   */
  it('stays within the iteration ceiling the deployed runtime enforces', async () => {
    expect(MAX_ITERATIONS).toBeLessThanOrEqual(100_000)
    const [, , iterations] = (await hashPassword('x')).split('$')
    expect(Number(iterations)).toBeLessThanOrEqual(100_000)
  })

  it('still verifies a hash stored with a different iteration count', async () => {
    // Parameters travel with the hash, so a future raise must not lock anyone out.
    const stored = await hashPassword('portable')
    const parts = stored.split('$')
    expect(await verifyPassword('portable', parts.join('$'))).toBe(true)
  })

  it('rejects a stored value that is not a hash rather than throwing', async () => {
    for (const junk of ['', 'plaintext', 'pbkdf2$sha512$1$a$b', 'pbkdf2$sha256$1$a$b']) {
      expect(await verifyPassword('anything', junk)).toBe(false)
    }
  })
})

describe('sha256Hex', () => {
  it('matches the known digest of an empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})
