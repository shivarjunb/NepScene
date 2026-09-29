import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest, notFound } from '../lib/http'
import {
  APPLY_ENVIRONMENTS, MAX_OUTPUT_BYTES, SELECT_RUN, notConfigured, outputKey, serialiseRun,
  type RunStatus, type ScrapeRunRow,
} from '../scrapes/runs'

/**
 * The runner's side of the scrape-run ledger (`/api/internal/scrape-runs`).
 *
 * Not a user: a GitHub Actions job on the self-hosted runner, authenticated
 * by one shared token (SCRAPE_REPORT_TOKEN) rather than a session. It may do
 * three things and nothing else — register a scheduled run, report a run's
 * status, and upload a run's output — none of which touches a listing. The
 * importers write drafts through wrangler with Cloudflare's own credentials;
 * this token cannot.
 */
export const internalScrapeRoutes = new Hono<{ Bindings: Env }>()

/** Constant-time, so a wrong token learns nothing from how long the answer took. */
function tokensMatch(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected)
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

internalScrapeRoutes.use('*', async (c, next) => {
  if (!c.env.SCRAPE_REPORT_TOKEN) throw notConfigured('Reporting scrape runs')
  const header = c.req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !tokensMatch(token, c.env.SCRAPE_REPORT_TOKEN)) {
    throw new ApiError(401, 'unauthenticated', 'That token does not open this')
  }
  await next()
})

const loadRun = async (env: Env, id: string) => {
  const row = await env.DB.prepare(`${SELECT_RUN} WHERE r.id = ?1`).bind(id).first<ScrapeRunRow>()
  if (!row) throw notFound('No such run')
  return row
}

const optionalInt = (value: unknown, name: string): number | null => {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || (value as number) < 0) throw badRequest('invalid_field', `${name} must be a non-negative integer`)
  return value as number
}

// ─── POST /api/internal/scrape-runs ──────────────────────────────────────────
/** A scheduled run has no console row waiting for it, so it opens its own. */
internalScrapeRoutes.post('/scrape-runs', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => { throw badRequest('invalid_json', 'Send a JSON body') })
  if (body.trigger !== 'schedule') throw badRequest('invalid_trigger', 'Only a scheduled run registers itself; a manual one is created by the console')
  const applyEnv = body.apply_env ?? null
  if (applyEnv !== null && !(APPLY_ENVIRONMENTS as readonly unknown[]).includes(applyEnv)) {
    throw badRequest('invalid_apply_env', `apply_env must be one of ${APPLY_ENVIRONMENTS.join(', ')} or null`)
  }
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO scrape_runs (id, trigger, status, apply_env, github_run_id, requested_at, started_at)
     VALUES (?1, 'schedule', 'running', ?2, ?3, ?4, ?4)`,
  ).bind(id, applyEnv, optionalInt(body.github_run_id, 'github_run_id'), now).run()
  return c.json(serialiseRun(await loadRun(c.env, id), c.env.GITHUB_REPOSITORY), 201)
})

// ─── PATCH /api/internal/scrape-runs/:id ─────────────────────────────────────
/**
 * `running` when the job begins; `succeeded` or `failed` with the summary
 * when it ends. Forward only: a finished run is not reopened by a late or
 * repeated report, so a retried workflow attempt cannot rewrite history.
 */
internalScrapeRoutes.patch('/scrape-runs/:id', async (c) => {
  const row = await loadRun(c.env, c.req.param('id'))
  const body = await c.req.json<Record<string, unknown>>().catch(() => { throw badRequest('invalid_json', 'Send a JSON body') })
  const status = body.status as RunStatus
  if (!['running', 'succeeded', 'failed'].includes(status)) throw badRequest('invalid_status', 'status is running, succeeded or failed')
  if (row.status === 'succeeded' || row.status === 'failed') {
    throw new ApiError(409, 'already_finished', `This run already ${row.status}`)
  }
  if (body.summary !== undefined && body.summary !== null && (typeof body.summary !== 'object' || !Array.isArray((body.summary as { jobs?: unknown }).jobs))) {
    throw badRequest('invalid_summary', 'summary is the runner\'s summary.json object')
  }
  const error = body.error === undefined || body.error === null ? null : String(body.error).slice(0, 1000)
  const now = new Date().toISOString()
  const finished = status !== 'running'
  await c.env.DB.prepare(
    `UPDATE scrape_runs
        SET status = ?2,
            github_run_id = COALESCE(?3, github_run_id),
            started_at = COALESCE(started_at, ?4),
            finished_at = CASE WHEN ?5 THEN ?4 ELSE finished_at END,
            summary = COALESCE(?6, summary),
            error = CASE WHEN ?5 THEN ?7 ELSE error END
      WHERE id = ?1`,
  ).bind(
    row.id, status, optionalInt(body.github_run_id, 'github_run_id'), now, finished ? 1 : 0,
    body.summary ? JSON.stringify(body.summary) : null, error,
  ).run()
  return c.json(serialiseRun(await loadRun(c.env, row.id), c.env.GITHUB_REPOSITORY))
})

// ─── PUT /api/internal/scrape-runs/:id/output ────────────────────────────────
/** The output tarball, into the media bucket under `scrapes/`. Replaces any earlier upload for the run. */
internalScrapeRoutes.put('/scrape-runs/:id/output', async (c) => {
  const row = await loadRun(c.env, c.req.param('id'))
  const length = Number(c.req.header('content-length') ?? NaN)
  if (!Number.isFinite(length) || length <= 0) throw badRequest('missing_body', 'Send the tarball as the request body with a content-length')
  if (length > MAX_OUTPUT_BYTES) throw new ApiError(413, 'too_large', `Output is limited to ${MAX_OUTPUT_BYTES} bytes`)
  const key = outputKey(row.id)
  await c.env.MEDIA.put(key, c.req.raw.body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { run_id: row.id },
  })
  await c.env.DB.prepare('UPDATE scrape_runs SET output_key = ?2 WHERE id = ?1').bind(row.id, key).run()
  return c.json({ id: row.id, output_key: key, size: length })
})
