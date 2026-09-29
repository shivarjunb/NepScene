import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

/**
 * The scrape-run ledger (migration 0015), from both ends: the admin console
 * that starts a run and reads the history, and the runner that reports back
 * with a shared token. What is settled here is that the console cannot start
 * a run on top of a running one, that a refused dispatch is a visible failed
 * row and not a silent one, that the runner's token opens exactly three
 * doors, and that a finished run cannot be rewritten by a late report.
 */

let ipCounter = 0
const nextIp = () => `192.0.2.${(ipCounter++ % 250) + 1}`

async function signIn(email: string, role: 'editor' | 'admin') {
  const response = await SELF.fetch('https://nepscene.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email, password: 'a-decent-passphrase' }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  await env.DB.prepare('UPDATE users SET role = ?1 WHERE email = ?2').bind(role, email).run()
  const { id } = (await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email)
    .first<{ id: string }>())!
  return { cookie, id }
}

const admin = (method: string, path: string, cookie: string, body?: unknown) =>
  SELF.fetch(`https://nepscene.test/api/admin${path}`, {
    method,
    headers: body === undefined ? { cookie } : { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const runner = (method: string, path: string, body?: unknown, init: { token?: string; raw?: BodyInit; type?: string } = {}) =>
  SELF.fetch(`https://nepscene.test/api/internal/scrape-runs${path}`, {
    method,
    headers: {
      ...(init.token === '' ? {} : { authorization: `Bearer ${init.token ?? 'runner-token'}` }),
      'content-type': init.type ?? 'application/json',
    },
    body: init.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  })

const SUMMARY = {
  started_at: '2026-09-20T00:15:00.000Z', finished_at: '2026-09-20T00:17:00.000Z', apply: 'production', complete: false,
  jobs: [
    { name: 'ticketsanjal', success: true, exit_code: 0, signal: null, error: null },
    { name: 'venues', success: false, exit_code: 1, signal: null, error: null },
    { name: 'taragaon-import', success: true, exit_code: 0, signal: null, error: null, import: { new_drafts: 3, duplicates: 1 } },
  ],
}

/** GitHub's dispatch endpoint, stubbed: 204 unless told otherwise. */
function stubGitHub(status = 204, body = '') {
  const calls: { url: string; init: RequestInit }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://api.github.com/')) {
      calls.push({ url, init: init ?? {} })
      return new Response(body, { status })
    }
    throw new Error(`unexpected fetch to ${url}`)
  })
  return calls
}

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM scrape_runs'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
  env.GITHUB_DISPATCH_TOKEN = 'gh-token'
  env.SCRAPE_REPORT_TOKEN = 'runner-token'
})

afterEach(() => vi.restoreAllMocks())

describe('starting a run from the console', () => {
  it('is admins only', async () => {
    const { cookie: editor } = await signIn('editor@example.np', 'editor')
    expect((await admin('POST', '/system/scrape', editor)).status).toBe(403)
    expect((await admin('GET', '/system/scrape-runs', editor)).status).toBe(403)
    expect((await admin('GET', '/system/scrape-runs', '')).status).toBe(401)
  })

  it('records a queued run, dispatches the workflow with its id, and audits who asked', async () => {
    const { cookie, id: adminId } = await signIn('admin@example.np', 'admin')
    const calls = stubGitHub()

    const response = await admin('POST', '/system/scrape', cookie)
    expect(response.status).toBe(201)
    const run = await response.json() as any
    expect(run.status).toBe('queued')
    expect(run.trigger).toBe('manual')
    expect(run.requested_by).toBe(adminId)
    // The test Worker runs as `local`, which has no D1 of its own to fill.
    expect(run.apply_env).toBe('preview')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.github.com/repos/shivarjunb/NepScene/actions/workflows/daily-scrape.yml/dispatches')
    const sent = JSON.parse(calls[0]!.init.body as string)
    expect(sent).toEqual({ ref: 'main', inputs: { run_id: run.id, apply: 'preview', api_url: 'https://nepscene.test' } })
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer gh-token')

    const [audit] = (await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'scrape_requested'").all<any>()).results
    expect(audit.actor_id).toBe(adminId)
    expect(JSON.parse(audit.details).run_id).toBe(run.id)

    const history = await (await admin('GET', '/system/scrape-runs', cookie)).json() as any
    expect(history.data.map((r: any) => r.id)).toEqual([run.id])
    expect(history.configured).toBe(true)
  })

  it('refuses a second run while one is queued or running', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    stubGitHub()
    expect((await admin('POST', '/system/scrape', cookie)).status).toBe(201)
    const again = await admin('POST', '/system/scrape', cookie)
    expect(again.status).toBe(409)
    expect(((await again.json()) as any).error.code).toBe('already_running')
  })

  it('leaves a failed row behind when GitHub refuses the dispatch', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    stubGitHub(422, '{"message":"Workflow does not have workflow_dispatch trigger"}')
    const response = await admin('POST', '/system/scrape', cookie)
    expect(response.status).toBe(502)
    const history = await (await admin('GET', '/system/scrape-runs', cookie)).json() as any
    expect(history.data).toHaveLength(1)
    expect(history.data[0].status).toBe('failed')
    expect(history.data[0].error).toMatch(/HTTP 422/)
    // A failed dispatch does not block the next attempt.
    stubGitHub()
    expect((await admin('POST', '/system/scrape', cookie)).status).toBe(201)
  })

  it('says so when the environment has no dispatch token, rather than failing', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    env.GITHUB_DISPATCH_TOKEN = undefined
    expect((await admin('POST', '/system/scrape', cookie)).status).toBe(503)
    const history = await (await admin('GET', '/system/scrape-runs', cookie)).json() as any
    expect(history.configured).toBe(false)
  })

  it('gives up on a run the runner never reported on, after three hours', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    const old = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
    await env.DB.prepare(
      `INSERT INTO scrape_runs (id, trigger, status, requested_at) VALUES ('run_old', 'manual', 'running', ?1)`,
    ).bind(old).run()
    const history = await (await admin('GET', '/system/scrape-runs', cookie)).json() as any
    expect(history.data[0].status).toBe('failed')
    expect(history.data[0].error).toMatch(/did not report back/)
    stubGitHub()
    expect((await admin('POST', '/system/scrape', cookie)).status).toBe(201)
  })
})

describe('the runner reporting back', () => {
  it('needs the shared token, and only that token', async () => {
    expect((await runner('POST', '', { trigger: 'schedule' }, { token: '' })).status).toBe(401)
    expect((await runner('POST', '', { trigger: 'schedule' }, { token: 'wrong' })).status).toBe(401)
    expect((await runner('POST', '', { trigger: 'schedule' }, { token: 'runner-tokeN' })).status).toBe(401)
    env.SCRAPE_REPORT_TOKEN = undefined
    expect((await runner('POST', '', { trigger: 'schedule' })).status).toBe(503)
  })

  it('lets a scheduled run register itself, then finish with a summary and its output', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')

    const created = await runner('POST', '', { trigger: 'schedule', github_run_id: 35492942492, apply_env: 'production' })
    expect(created.status).toBe(201)
    const run = await created.json() as any
    expect(run.status).toBe('running')
    expect(run.trigger).toBe('schedule')
    expect(run.requested_by).toBeNull()
    expect(run.github_run_url).toBe('https://github.com/shivarjunb/NepScene/actions/runs/35492942492')

    const tarball = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3])
    const upload = await runner('PUT', `/${run.id}/output`, undefined, { raw: tarball, type: 'application/gzip' })
    expect(upload.status).toBe(200)
    expect(((await upload.json()) as any).output_key).toBe(`scrapes/${run.id}.tar.gz`)
    const stored = await env.MEDIA.get(`scrapes/${run.id}.tar.gz`)
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(tarball)

    const finished = await runner('PATCH', `/${run.id}`, { status: 'failed', summary: SUMMARY, error: 'venues failed' })
    expect(finished.status).toBe(200)
    const final = await finished.json() as any
    expect(final.status).toBe('failed')
    expect(final.finished_at).not.toBeNull()
    expect(final.drafts_created).toBe(3)
    expect(final.summary.jobs).toHaveLength(3)

    // The console sees it, and can hand the tarball back.
    const history = await (await admin('GET', '/system/scrape-runs', cookie)).json() as any
    expect(history.data[0].id).toBe(run.id)
    expect(history.data[0].error).toBe('venues failed')
    const download = await admin('GET', `/system/scrape-runs/${run.id}/output`, cookie)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/gzip')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(tarball)
  })

  it('moves a console-started run from queued to running to done, and will not reopen it', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    stubGitHub()
    const run = await (await admin('POST', '/system/scrape', cookie)).json() as any

    const started = await (await runner('PATCH', `/${run.id}`, { status: 'running', github_run_id: 7 })).json() as any
    expect(started.status).toBe('running')
    expect(started.started_at).not.toBeNull()
    expect(started.github_run_id).toBe(7)

    const done = await (await runner('PATCH', `/${run.id}`, { status: 'succeeded', summary: { ...SUMMARY, complete: true } })).json() as any
    expect(done.status).toBe('succeeded')
    expect(done.error).toBeNull()

    const late = await runner('PATCH', `/${run.id}`, { status: 'failed', error: 'a retry' })
    expect(late.status).toBe(409)
    expect((await (await admin('GET', '/system/scrape-runs', cookie)).json() as any).data[0].status).toBe('succeeded')
  })

  it('rejects what it does not understand', async () => {
    expect((await runner('POST', '', { trigger: 'manual' })).status).toBe(400)
    expect((await runner('POST', '', { trigger: 'schedule', apply_env: 'prod' })).status).toBe(400)
    expect((await runner('PATCH', '/no-such-run', { status: 'running' })).status).toBe(404)
    const run = await (await runner('POST', '', { trigger: 'schedule' })).json() as any
    expect((await runner('PATCH', `/${run.id}`, { status: 'queued' })).status).toBe(400)
    expect((await runner('PATCH', `/${run.id}`, { status: 'failed', summary: 'nope' })).status).toBe(400)
    expect((await runner('PUT', `/${run.id}/output`, undefined, { raw: new Uint8Array(0), type: 'application/gzip' })).status).toBe(400)
    // It cannot touch a listing: there is no such route behind the token.
    expect((await runner('POST', '/../../author/queue/actions', { action: 'publish', ids: [] })).status).not.toBe(200)
  })

  it('has no output to hand back for a run that never uploaded one', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    const run = await (await runner('POST', '', { trigger: 'schedule' })).json() as any
    expect((await admin('GET', `/system/scrape-runs/${run.id}/output`, cookie)).status).toBe(404)
    expect((await admin('GET', '/system/scrape-runs/nothing/output', cookie)).status).toBe(404)
  })
})
