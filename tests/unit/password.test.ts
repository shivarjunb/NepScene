import { describe, expect, it } from 'vitest'
import { hashPassword, sha256Hex, verifyPassword } from '../../api/identity/password'

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
    expect(await hashPassword('x')).toMatch(/^pbkdf2\$sha256\$210000\$[^$]+\$[^$]+$/)
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
