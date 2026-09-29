import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultReason } from '../../api/admin/deploys'

/**
 * "Deploy to production" from the staging console (api/admin/deploys.ts).
 * What is settled here: the routes exist on staging only; the button offers
 * the newest green staging commit that production lacks, named after what it
 * brings in; and a promotion is refused when it could not pass the
 * workflow's gate, or while another deploy is under way. And the automatic
 * path: a switch only a user manager can flip, audited; a callback only the
 * staging deploy's token opens; and, when on, the same refusals and the same
 * dispatch as the button, for the run that called and nothing else.
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

/**
 * Staging's deploy of commit 4, calling back from its last step: still
 * `in_progress`, so not yet among the successful runs GitHub lists.
 */
const callingRun = (overrides: Record<string, unknown> = {}) => ({
  ...stagingRun(4, 'feat: auto-promote (#138)'), status: 'in_progress', conclusion: null,
  head_branch: 'main', path: '.github/workflows/deploy-staging.yml', ...overrides,
})

/** GitHub, stubbed: staging has commits 3 (newest), 2 and 1; production is whatever the test says. */
function stubGitHub(production: unknown[], dispatchStatus = 204, calling: unknown = callingRun()) {
  const dispatches: { url: string; body: any }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (/\/actions\/runs\/\d+$/.test(url)) return Response.json(calling)
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
  await env.SETTINGS.delete('deploy:auto-promote')
  env.GITHUB_DISPATCH_TOKEN = 'gh-token'
  env.DEPLOY_CALLBACK_TOKEN = 'deploy-token'
  env.SCRAPE_REPORT_TOKEN = 'scrape-token'
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

const setAuto = (cookie: string, enabled: unknown) =>
  SELF.fetch('https://nepscene.test/api/admin/system/deploy/auto', {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  })

const callback = (body: unknown, token = 'deploy-token') =>
  SELF.fetch('https://nepscene.test/api/internal/staging-deploys', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('promoting automatically after a green staging deploy', () => {
  it('is off until a user manager turns it on, and each change is audited', async () => {
    const cookie = await signIn('admin@example.np', 'admin')
    const editor = await signIn('editor@example.np', 'editor')
    stubGitHub([productionRun(1)])
    expect(((await (await admin('GET', cookie)).json()) as any).auto_promote).toBe(false)

    expect((await setAuto(editor, true)).status).toBe(403)
    expect((await setAuto(cookie, 'yes')).status).toBe(400)
    expect(((await (await admin('GET', cookie)).json()) as any).auto_promote).toBe(false)

    expect(((await (await setAuto(cookie, true)).json()) as any).auto_promote).toBe(true)
    expect(((await (await admin('GET', cookie)).json()) as any).auto_promote).toBe(true)
    expect((await setAuto(cookie, false)).status).toBe(200)
    expect(((await (await admin('GET', cookie)).json()) as any).auto_promote).toBe(false)

    const { results } = await env.DB.prepare(
      `SELECT a.action, u.email FROM audit_log a JOIN users u ON u.id = a.actor_id
        WHERE a.action LIKE 'production_autodeploy_%' ORDER BY a.created_at, a.rowid`,
    ).all<{ action: string; email: string }>()
    expect(results).toEqual([
      { action: 'production_autodeploy_enabled', email: 'admin@example.np' },
      { action: 'production_autodeploy_disabled', email: 'admin@example.np' },
    ])

    env.ENVIRONMENT = 'production'
    expect((await setAuto(cookie, true)).status).toBe(404)
  })

  it('opens the callback to the staging deploy’s token only', async () => {
    const dispatches = stubGitHub([productionRun(2)])
    await env.SETTINGS.put('deploy:auto-promote', 'on')
    const body = { sha: sha(4), run_id: 4 }
    expect((await callback(body, 'wrong-token')).status).toBe(401)
    // The scrape runner's token opens the scrape routes, not this one.
    expect((await callback(body, 'scrape-token')).status).toBe(401)
    expect((await SELF.fetch('https://nepscene.test/api/internal/staging-deploys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).status).toBe(401)
    // …and this token does not open the scrape routes.
    expect((await SELF.fetch('https://nepscene.test/api/internal/scrape-sources', {
      headers: { authorization: 'Bearer deploy-token' },
    })).status).toBe(401)
    env.DEPLOY_CALLBACK_TOKEN = undefined
    expect((await callback(body)).status).toBe(503)
    expect(dispatches).toHaveLength(0)
  })

  it('does nothing while the switch is off', async () => {
    const dispatches = stubGitHub([productionRun(2)])
    const response = await callback({ sha: sha(4), run_id: 4 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ promoted: false, reason: 'disabled' })
    expect(dispatches).toHaveLength(0)
  })

  it('when on, promotes the run that called — green or not in GitHub’s list yet — named "Auto: …"', async () => {
    const dispatches = stubGitHub([productionRun(2)])
    await env.SETTINGS.put('deploy:auto-promote', 'on')
    const response = await callback({ sha: sha(4), run_id: 4 })
    expect(response.status).toBe(202)
    expect(((await response.json()) as any).promoted).toBe(true)
    const reason = 'Auto: feat: auto-promote (#138); fix: scrapes (#137)'
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]!.body).toEqual({ ref: 'main', inputs: { sha: sha(4), reason } })
    const audit = await env.DB.prepare("SELECT actor_id, actor_role, details FROM audit_log WHERE action = 'production_deploy_requested'")
      .first<{ actor_id: string | null; actor_role: string | null; details: string }>()
    expect(audit!.actor_id).toBeNull()
    expect(audit!.actor_role).toBeNull()
    expect(JSON.parse(audit!.details)).toEqual({ sha: sha(4), reason, automatic: true, staging_run: 4 })
  })

  it('when on, starts nothing while another production deploy is under way', async () => {
    const dispatches = stubGitHub([productionRun(3, 'waiting', null), productionRun(2)])
    await env.SETTINGS.put('deploy:auto-promote', 'on')
    const response = await callback({ sha: sha(4), run_id: 4 })
    expect(response.status).toBe(200)
    expect(((await response.json()) as any).reason).toBe('already_deploying')
    expect(dispatches).toHaveLength(0)
  })

  it('when on, starts nothing for a commit production already has, or a run that is not the one claimed', async () => {
    await env.SETTINGS.put('deploy:auto-promote', 'on')
    // A re-run of staging for the commit production is already on.
    let dispatches = stubGitHub([productionRun(3)], 204, callingRun({ id: 3, head_sha: sha(3) }))
    let response = await callback({ sha: sha(3), run_id: 3 })
    expect(((await response.json()) as any).reason).toBe('not_on_staging')
    expect(dispatches).toHaveLength(0)

    // The body names one commit; the run it names deployed another, from a
    // branch, or failed.
    const mismatches: [Record<string, unknown>, string][] = [
      [callingRun(), sha(9)],
      [callingRun({ head_branch: 'feature' }), sha(4)],
      [callingRun({ status: 'completed', conclusion: 'failure' }), sha(4)],
      [callingRun({ path: '.github/workflows/preview.yml' }), sha(4)],
    ]
    for (const [calling, claimed] of mismatches) {
      vi.restoreAllMocks()
      dispatches = stubGitHub([productionRun(2)], 204, calling)
      response = await callback({ sha: claimed, run_id: 4 })
      expect(((await response.json()) as any).reason).toBe('not_this_run')
      expect(dispatches).toHaveLength(0)
    }
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
