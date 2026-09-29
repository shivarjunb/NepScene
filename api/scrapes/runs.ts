import type { Env } from '../env'
import { ApiError } from '../lib/http'
import { swallowed } from '../lib/observability'

/**
 * The scrape-run ledger (migration 0015), shared by its two writers: the
 * admin console (api/admin/scrapes.ts), which starts runs and shows them,
 * and the runner (api/internal/scrapes.ts), which reports how they went.
 */

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const APPLY_ENVIRONMENTS = ['preview', 'staging', 'production'] as const
export type ApplyEnvironment = (typeof APPLY_ENVIRONMENTS)[number]

/** One scraper's line in the runner's summary.json (scripts/scrape-all.mjs). */
export type JobSummary = {
  name: string
  success: boolean
  skipped?: boolean
  exit_code: number | null
  signal: string | null
  error: string | null
  /** The importer's own count of what it wrote, for the import jobs only. */
  import?: { new_drafts?: number; new_published?: number; duplicates?: number; excluded?: number } | null
}

export type RunSummary = {
  started_at: string
  finished_at?: string
  apply: string | null
  complete: boolean
  jobs: JobSummary[]
}

export type ScrapeRunRow = {
  id: string
  trigger: 'schedule' | 'manual'
  requested_by: string | null
  requested_by_name?: string | null
  status: RunStatus
  apply_env: ApplyEnvironment | null
  github_run_id: number | null
  summary: string | null
  output_key: string | null
  error: string | null
  requested_at: string
  started_at: string | null
  finished_at: string | null
}

export type ScrapeRun = Omit<ScrapeRunRow, 'summary'> & {
  summary: RunSummary | null
  /** Drafts the importers created in this run, summed across importers. */
  drafts_created: number
  /** The workflow run on GitHub, for the log; null until the runner reports. */
  github_run_url: string | null
}

export function serialiseRun(row: ScrapeRunRow, repository: string): ScrapeRun {
  let summary: RunSummary | null = null
  if (row.summary) {
    try { summary = JSON.parse(row.summary) as RunSummary } catch (cause) {
      // The runner wrote it and the API checked it had `jobs` on the way in;
      // a row that will not parse is worth a count, not a broken screen.
      swallowed('scrape_run_summary_unparseable', cause, { run_id: row.id })
    }
  }
  const drafts = (summary?.jobs ?? []).reduce((n, job) => n + (job.import?.new_drafts ?? 0), 0)
  return {
    ...row,
    summary,
    drafts_created: drafts,
    github_run_url: row.github_run_id
      ? `https://github.com/${repository}/actions/runs/${row.github_run_id}`
      : null,
  }
}

/** Where a run's output tarball lives in the media bucket. */
export const outputKey = (runId: string) => `scrapes/${runId}.tar.gz`

/** The runner's tarball is JSON and logs: a few megabytes. 50 MB is generous. */
export const MAX_OUTPUT_BYTES = 50 * 1024 * 1024

/**
 * A run the runner never reported on. The workflow's own timeout is 75
 * minutes and a run can queue behind CI on the one runner; three hours
 * without a word means the job never started or died before `finish`.
 */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000

/**
 * Failing the runs nobody will hear from again, on read. Cheaper than a cron
 * and exactly as timely as anyone looking, which is when it matters: a
 * `running` row from Tuesday would otherwise block Thursday's button.
 */
export function expireStaleRuns(env: Env, now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS).toISOString()
  return env.DB.prepare(
    `UPDATE scrape_runs
        SET status = 'failed', finished_at = ?1,
            error = 'The runner did not report back within three hours'
      WHERE status IN ('queued', 'running') AND requested_at < ?2`,
  ).bind(now.toISOString(), cutoff)
}

export const SELECT_RUN = `
  SELECT r.id, r.trigger, r.requested_by, u.name AS requested_by_name, r.status, r.apply_env,
         r.github_run_id, r.summary, r.output_key, r.error, r.requested_at, r.started_at, r.finished_at
    FROM scrape_runs r LEFT JOIN users u ON u.id = r.requested_by`

export const notConfigured = (what: string) =>
  new ApiError(503, 'not_configured', `${what} is not configured in this environment`)
