import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultReason } from '../../api/admin/deploys'

/**
 * "Deploy to production" from the staging console (api/admin/deploys.ts).
 * What is settled here: the routes exist on staging only; the button offers
 * the newest green staging commit that production lacks, named after what it
 * brings in; and a promotion is refused when it could not pass the
 * workflow's gate, or while another deploy is under way.
 */

let ipCounter = 0
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`

async function signIn(email: string, role: 'editor' | 'admin') {
  const response = await SELF.fetch('https://nepscene.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email, password: 'a-decent-passphrase' }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  await env.DB.prepare('UPDATE users SET role = ?1 WHERE email = ?2').bind(role, email).run()
  return cookie
}

const admin = (method: string, cookie: string, body?: unknown) =>
  SELF.fetch('https://nepscene.test/api/admin/system/deploy', {
    method,
    headers: body === undefined ? { cookie } : { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const sha = (n: number) => String(n).repeat(40).slice(0, 40)
const stagingRun = (n: number, title: string) => ({
  id: n, head_sha: sha(n), status: 'completed', conclusion: 'success', display_title: title,
  html_url: `https://github.com/runs/${n}`, created_at: `2026-09-2${n}T00:00:00Z`, head_commit: { message: `${title}\n\nbody` },
})
const productionRun = (n: number, status = 'completed', conclusion: string | null = 'success') => ({
  id: 100 + n, head_sha: 'f'.repeat(40), status, conclusion, display_title: `Deploy ${sha(n)} — something`,
  html_url: `https://github.com/runs/p${n}`, created_at: `2026-09-2${n}T01:00:00Z`,
})

/** GitHub, stubbed: staging has commits 3 (newest), 2 and 1; production is whatever the test says. */
function stubGitHub(production: unknown[], dispatchStatus = 204) {
  const dispatches: { url: string; body: any }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/deploy-staging.yml/runs')) {
      return Response.json({ workflow_runs: [stagingRun(3, 'fix: scrapes (#137)'), stagingRun(2, 'feat: sources (#136)'), stagingRun(1, 'feat: sign-in (#134)')] })
    }
    if (url.includes('/deploy-production.yml/runs')) return Response.json({ workflow_runs: production })
    if (url.endsWith('/deploy-production.yml/dispatches')) {
      dispatches.push({ url, body: JSON.parse(init!.body as string) })
      return new Response('', { status: dispatchStatus })
    }
    throw new Error(`unexpected fetch to ${url}`)
  })
  return dispatches
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
  env.GITHUB_DISPATCH_TOKEN = 'gh-token'
  env.ENVIRONMENT = 'staging'
})

afterEach(() => {
  vi.restoreAllMocks()
  env.ENVIRONMENT = 'local'
})

describe('deploy to production from the staging console', () => {
  it('exists on staging only, for admins only', async () => {
    const cookie = await signIn('admin@example.np', 'admin')
    const editor = await signIn('editor@example.np', 'editor')
    stubGitHub([productionRun(1)])
    expect((await admin('GET', editor)).status).toBe(403)
    expect((await admin('GET', cookie)).status).toBe(200)
    for (const environment of ['production', 'preview', 'local'] as const) {
      env.ENVIRONMENT = environment
      expect((await admin('GET', cookie)).status).toBe(404)
      expect((await admin('POST', cookie, { sha: sha(3), reason: 'x' })).status).toBe(404)
    }
  })

  it('offers the newest staging commit, named after every commit production lacks', async () => {
    const cookie = await signIn('admin@example.np', 'admin')
    stubGitHub([productionRun(1)])
    const state = await (await admin('GET', cookie)).json() as any
    expect(state.production.sha).toBe(sha(1))
    expect(state.candidate.sha).toBe(sha(3))
    expect(state.ahead.map((c: any) => c.sha)).toEqual([sha(3), sha(2)])
    expect(state.reason).toBe('fix: scrapes (#137); feat: sources (#136)')
    expect(state.active).toBeNull()
  })

  it('dispatches the production workflow with the commit and reason, and audits who asked', async () => {
    const cookie = await signIn('admin@example.np', 'admin')
    const dispatches = stubGitHub([productionRun(2)])
    const response = await admin('POST', cookie, { sha: sha(3), reason: 'fix: scrapes (#137)' })
    expect(response.status).toBe(202)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]!.body).toEqual({ ref: 'main', inputs: { sha: sha(3), reason: 'fix: scrapes (#137)' } })
    const audit = await env.DB.prepare("SELECT details FROM audit_log WHERE action = 'production_deploy_requested'").first<{ details: string }>()
    expect(JSON.parse(audit!.details)).toEqual({ sha: sha(3), reason: 'fix: scrapes (#137)' })
  })

  it('refuses what the gate would refuse, and a second deploy while one is waiting', async () => {
    const cookie = await signIn('admin@example.np', 'admin')
    let dispatches = stubGitHub([productionRun(2)])
    // Already on production, or never green on staging.
    expect((await admin('POST', cookie, { sha: sha(2), reason: 'again' })).status).toBe(409)
    expect((await admin('POST', cookie, { sha: sha(9), reason: 'unknown' })).status).toBe(409)
    expect((await admin('POST', cookie, { sha: 'abc123', reason: 'short' })).status).toBe(400)
    expect((await admin('POST', cookie, { sha: sha(3), reason: '  ' })).status).toBe(400)
    expect(dispatches).toHaveLength(0)

    vi.restoreAllMocks()
    dispatches = stubGitHub([productionRun(3, 'waiting', null), productionRun(2)])
    const state = await (await admin('GET', cookie)).json() as any
    expect(state.active.status).toBe('waiting')
    const again = await admin('POST', cookie, { sha: sha(3), reason: 'twice' })
    expect(again.status).toBe(409)
    expect(((await again.json()) as any).error.code).toBe('already_deploying')
    expect(dispatches).toHaveLength(0)
  })

  it('offers only the newest commit when production’s commit is unknown', async () => {
    const cookie = await signIn('admin@example.np', 'admin')
    stubGitHub([{ ...productionRun(1), display_title: 'Deploy to production' }])
    const state = await (await admin('GET', cookie)).json() as any
    expect(state.production).toBeNull()
    expect(state.ahead.map((c: any) => c.sha)).toEqual([sha(3)])
  })

  it('says so when GitHub refuses the dispatch or the token is missing', async () => {
    const cookie = await signIn('admin@example.np', 'admin')
    stubGitHub([productionRun(1)], 403)
    expect((await admin('POST', cookie, { sha: sha(3), reason: 'go' })).status).toBe(502)
    env.GITHUB_DISPATCH_TOKEN = undefined
    expect((await admin('GET', cookie)).status).toBe(503)
  })
})

describe('the default deploy name', () => {
  it('lists short histories whole and summarises long ones', () => {
    const commit = (title: string) => ({ sha: sha(1), title, deployed_at: '', run_url: '' })
    expect(defaultReason([])).toBe('')
    expect(defaultReason([commit('a (#1)'), commit('b (#2)')])).toBe('a (#1); b (#2)')
    const long = defaultReason(Array.from({ length: 12 }, (_, i) => commit(`feat: a fairly long pull request title number ${i}`)))
    expect(long).toMatch(/^12 changes: feat: a fairly long pull request title number 0; and 11 more$/)
  })
})
