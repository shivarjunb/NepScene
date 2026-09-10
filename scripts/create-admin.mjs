#!/usr/bin/env node
/**
 * Create or reset an admin account (#28).
 *
 * There is no sign-up path to `admin`: POST /api/auth/register hardcodes
 * 'visitor', which is correct — a public endpoint that can mint an admin is
 * not an endpoint, it is a door. So the first admin of any environment has to
 * be written directly, and this is the supported way to do it.
 *
 * It is an upsert, so it is also the password reset: an environment whose
 * admin password was set by hand and then forgotten is not locked out, because
 * nothing here reads the old hash.
 *
 * No credential is stored in this file. The password is either given on the
 * command line or generated per run and printed once — it exists in the
 * database as a PBKDF2 digest and nowhere else, which is why losing it means
 * running this again rather than looking it up.
 *
 * Usage:
 *   node scripts/create-admin.mjs                                  # local, generated password
 *   node scripts/create-admin.mjs --env staging
 *   node scripts/create-admin.mjs --env staging --email me@example.com --password '...'
 *   node scripts/create-admin.mjs --env production --force
 */
import { execFileSync } from 'node:child_process'
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const ENV = arg('env', null)
const ROLE = arg('role', 'admin')
const NAME = arg('name', 'NepScene admin')
const EMAIL = String(arg('email', `admin@${ENV ?? 'local'}.nepscene.test`)).trim().toLowerCase()
const DRY_RUN = args.includes('--dry-run')

if (!['visitor', 'organizer', 'editor', 'admin'].includes(ROLE)) {
  console.error(`--role must be one of visitor, organizer, editor, admin (got ${ROLE})`)
  process.exit(1)
}

// Production holds real accounts and a real audit trail. Resetting a password
// there is legitimate and occasionally necessary, but it should never be the
// thing that happens because a --env flag was left off the previous command.
if (ENV === 'production' && !args.includes('--force')) {
  console.error('Refusing to write to production without --force.')
  process.exit(1)
}

/**
 * Generated rather than defaulted. A script with a built-in password produces
 * environments that all share it, and the one that reaches the internet is
 * discovered by whoever reads this file.
 *
 * 18 bytes, base64url: ~143 bits, no characters that a shell, a URL or a
 * double-click-to-select will mangle.
 */
const password = String(arg('password', randomBytes(18).toString('base64url')))
if (password.length < 10) {
  console.error('Password must be at least 10 characters — the API enforces the same minimum.')
  process.exit(1)
}

/**
 * Must match api/identity/password.ts exactly: same KDF, same field order, and
 * — above all — an iteration count the deployed runtime will actually accept.
 *
 * Workers refuses PBKDF2 above 100,000 iterations with `NotSupportedError`.
 * Node has no such ceiling, so a higher count here writes a row that looks
 * perfect, verifies fine locally, and makes every sign-in against the deployed
 * Worker answer 500. The count travels with the hash, so this is read back
 * from the stored string rather than assumed — but it still has to be a count
 * the reader can run.
 */
function hashPassword(plain) {
  const ITERATIONS = 100_000
  const salt = randomBytes(16)
  const hash = pbkdf2Sync(plain, salt, ITERATIONS, 32, 'sha256')
  return `pbkdf2$sha256$${ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`
}

const esc = (value) => `'${String(value).replace(/'/g, "''")}'`

const now = new Date().toISOString()
const sql = `
-- Written by scripts/create-admin.mjs. Safe to re-run.
INSERT INTO users (id, email, email_verified, name, password_hash, role, is_active, created_at, updated_at)
VALUES (${esc(randomUUID())}, ${esc(EMAIL)}, 1, ${esc(NAME)}, ${esc(hashPassword(password))}, ${esc(ROLE)}, 1, ${esc(now)}, ${esc(now)})
ON CONFLICT(email) DO UPDATE SET
  password_hash  = excluded.password_hash,
  role           = excluded.role,
  name           = excluded.name,
  -- No mailbox is reachable outside production (docs/BACKLOG.md — email
  -- delivery is deferred), so an admin that had to verify by clicking a link
  -- could never verify at all.
  email_verified = 1,
  is_active      = 1,
  updated_at     = excluded.updated_at;

-- The password just changed, so every session opened with the old one is now
-- a credential nobody chose to keep issuing.
UPDATE user_sessions
   SET revoked_at = ${esc(now)}
 WHERE revoked_at IS NULL
   AND user_id = (SELECT id FROM users WHERE email = ${esc(EMAIL)});
`

if (DRY_RUN) {
  console.log(sql)
  process.exit(0)
}

const file = join(mkdtempSync(join(tmpdir(), 'nepscene-admin-')), 'admin.sql')
writeFileSync(file, sql)

// A binding name like DB only resolves inside its environment; the local
// database is addressed by name because there is no --env to resolve it.
const wranglerArgs = ['wrangler', 'd1', 'execute', ENV ? 'DB' : 'nepscene-local']
if (ENV) wranglerArgs.push('--env', ENV, '--remote')
else wranglerArgs.push('--local')
wranglerArgs.push(`--file=${file}`, '--yes')

execFileSync('npx', wranglerArgs, { stdio: ['ignore', 'ignore', 'inherit'] })

console.log(`\n  ${ROLE} account written to ${ENV ?? 'local'}\n`)
console.log(`  email     ${EMAIL}`)
console.log(`  password  ${password}\n`)
console.log('  Shown once — it is stored only as a PBKDF2 digest. Put it in a')
console.log('  password manager; do not commit it. Re-run this script to reset it.\n')
