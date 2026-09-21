import { Hono } from 'hono'
import type { Env } from '../env'
import { readSession, rowsOf, withRoundTrips } from '../lib/d1'
import { auditStatement } from '../lib/audit'
import { ApiError, notFound } from '../lib/http'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import {
  APPLY_ENVIRONMENTS, SELECT_RUN, expireStaleRuns, notConfigured, serialiseRun,
  type ApplyEnvironment, type ScrapeRunRow,
} from '../scrapes/runs'

/**
 * The scrapers, from the console (`/api/admin/system/scrape*`).
 *
 * The scrapers themselves cannot run here — they drive a browser — so "run
 * now" means: write a `queued` row, then ask GitHub to start the
 * `daily-scrape.yml` workflow on the self-hosted runner with that row's id.
 * The runner does the work and reports back through /api/internal, and this
 * screen shows what it said. The console never talks to the runner directly:
 * the runner is a machine in a house with no inbound port, and GitHub is the
 * queue it already polls.
 */
export const adminScrapeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const WORKFLOW = 'daily-scrape.yml'
const REF = 'main'
const RECENT = 20

/**
 * Which D1 the importers write drafts into: this console's own environment.
 * A staging admin pressing the button fills staging's queue, not production's
 * — the alternative is a button whose effect depends on which tab it was
 * pressed in. Local and preview have no D1 of their own that the runner can
 * reach, so they target preview.
 */
export function applyEnvironmentFor(environment: Env['ENVIRONMENT']): ApplyEnvironment {
  return (APPLY_ENVIRONMENTS as readonly string[]).includes(environment)
    ? (environment as ApplyEnvironment)
    : 'preview'
}

/** GitHub's answer to a dispatch, reduced to what the row records. */
export async function dispatchWorkflow(env: Env, inputs: Record<string, string>, fetcher = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await fetcher(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'nepscene-admin',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ref: REF, inputs }),
    },
  )
  if (response.status === 204) return { ok: true }
  const detail = (await response.text()).slice(0, 200)
  return { ok: false, error: `GitHub refused the dispatch: HTTP ${response.status} ${detail}`.trim() }
}

// ─── POST /api/admin/system/scrape ───────────────────────────────────────────
/**
 * Start a run. Refused while one is queued or running: the workflow has a
 * concurrency group of one, so a second dispatch would only queue behind the
 * first and then repeat it. Recorded in the audit log because a run that
 * writes drafts into the queue is something a person can be asked about.
 */
adminScrapeRoutes.post('/system/scrape', requirePermission('user:manage'), async (c) => {
  if (!c.env.GITHUB_DISPATCH_TOKEN) throw notConfigured('Starting a scrape run')
  const actor = c.get('user')
  const now = new Date()

  await expireStaleRuns(c.env, now).run()
  const active = await c.env.DB.prepare(
    `SELECT id, status FROM scrape_runs WHERE status IN ('queued', 'running') ORDER BY requested_at DESC LIMIT 1`,
  ).first<{ id: string; status: string }>()
  if (active) {
    throw new ApiError(409, 'already_running', `A run is already ${active.status}; wait for it to finish`)
  }

  const id = crypto.randomUUID()
  const applyEnv = applyEnvironmentFor(c.env.ENVIRONMENT)
  await c.env.DB.prepare(
    `INSERT INTO scrape_runs (id, trigger, requested_by, status, apply_env, requested_at)
     VALUES (?1, 'manual', ?2, 'queued', ?3, ?4)`,
  ).bind(id, actor.id, applyEnv, now.toISOString()).run()

  // The runner reports to the API that owns the row — this one — so the
  // origin travels with the dispatch. A staging run reports to staging.
  const dispatched = await dispatchWorkflow(c.env, { run_id: id, apply: applyEnv, api_url: new URL(c.req.url).origin })
  if (!dispatched.ok) {
    // The row stays, failed, so the attempt is visible in the history rather
    // than vanishing into a toast.
    await c.env.DB.prepare(
      `UPDATE scrape_runs SET status = 'failed', error = ?2, finished_at = ?3 WHERE id = ?1`,
    ).bind(id, dispatched.error, new Date().toISOString()).run()
    throw new ApiError(502, 'dispatch_failed', dispatched.error)
  }

  await auditStatement(c.env, {
    entityType: 'listing', entityId: 'import', action: 'scrape_requested',
    actorId: actor.id, actorRole: actor.role,
    details: { run_id: id, apply_env: applyEnv },
  }).run()

  const row = await c.env.DB.prepare(`${SELECT_RUN} WHERE r.id = ?1`).bind(id).first<ScrapeRunRow>()
  return c.json(serialiseRun(row!, c.env.GITHUB_REPOSITORY), 201)
})

// ─── GET /api/admin/system/scrape-runs ───────────────────────────────────────
/**
 * The recent runs, newest first, and how many imported drafts are waiting in
 * the queue — the number that tells an admin whether to go and publish.
 */
adminScrapeRoutes.get('/system/scrape-runs', requirePermission('user:manage'), async (c) => {
  await expireStaleRuns(c.env).run()
  const session = readSession(c.env)
  const [runs = [], pending = []] = await session.batch([
    { sql: `${SELECT_RUN} ORDER BY r.requested_at DESC LIMIT ?1`, params: [RECENT] },
    { sql: `SELECT COUNT(*) AS n FROM listings WHERE source = 'import' AND status = 'draft'` },
  ])
  return withRoundTrips(c.json({
    data: rowsOf<ScrapeRunRow>({ results: runs }).map((row) => serialiseRun(row, c.env.GITHUB_REPOSITORY)),
    pending_imports: Number((pending[0] as { n?: number } | undefined)?.n ?? 0),
    configured: Boolean(c.env.GITHUB_DISPATCH_TOKEN),
  }), session)
})

// ─── GET /api/admin/system/scrape-runs/:id/output ────────────────────────────
/** The run's full output — every scraper's files and logs — as the runner tarred it. */
adminScrapeRoutes.get('/system/scrape-runs/:id/output', requirePermission('user:manage'), async (c) => {
  const row = await c.env.DB.prepare('SELECT output_key FROM scrape_runs WHERE id = ?1')
    .bind(c.req.param('id')).first<{ output_key: string | null }>()
  if (!row?.output_key) throw notFound('That run has no output stored')
  const object = await c.env.MEDIA.get(row.output_key)
  if (!object) throw notFound('That run\'s output is no longer in storage')
  return new Response(object.body, {
    headers: {
      'content-type': 'application/gzip',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="scrape-${c.req.param('id')}.tar.gz"`,
      'cache-control': 'private, no-store',
    },
  })
})
