import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

/**
 * An account the journey specs can actually sign in as (#48).
 *
 * The criterion is that the journeys run "against a real preview deployment,
 * not mocks", and the half of that which matters is **not mocks**. Every other
 * spec here stubs `/api/auth/me` and hands the app a role — which is right when
 * the subject is a wizard step, and useless for a journey whose whole claim is
 * that signing in, creating, publishing and moderating work end to end. A
 * stubbed session proves the stub returns what it was told to.
 *
 * So the journeys sign in for real, against the local Worker and the seeded
 * local D1 that `playwright.config.ts` already starts. That is not a deployed
 * preview — the difference is Cloudflare's edge and a remote D1, neither of
 * which these journeys are about — but it is the same Worker, the same
 * migrations, the same password verification and the same session cookie.
 *
 * **The password is generated per run and never written to the repository.**
 * A fixed test credential would either trip `scripts/check-secrets.mjs` or
 * need an exemption in it, and an exemption in a credential guard is how the
 * guard stops meaning anything. It reaches the workers through the environment:
 * `globalSetup` runs in the main process before any worker is spawned, so
 * assigning to `process.env` here is inherited by all of them.
 */
export default function globalSetup() {
  const password = randomBytes(18).toString('base64url')

  for (const [role, email] of [
    ['editor', 'e2e-editor@nepscene.test'],
    ['organizer', 'e2e-organizer@nepscene.test'],
  ] as const) {
    execFileSync('node', [
      'scripts/create-admin.mjs',
      '--role', role,
      '--email', email,
      '--name', `E2E ${role}`,
      '--password', password,
    ], { stdio: 'pipe' })
  }

  process.env.E2E_PASSWORD = password
  process.env.E2E_EDITOR_EMAIL = 'e2e-editor@nepscene.test'
  process.env.E2E_ORGANIZER_EMAIL = 'e2e-organizer@nepscene.test'
}
