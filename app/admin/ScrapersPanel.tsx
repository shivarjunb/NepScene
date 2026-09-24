import { useCallback, useEffect, useState } from 'react'
import { Link } from '../router'
import { Alert, Badge, Button, Card } from '../components/primitives'
import { AuthorError } from '../lib/author'
import {
  fetchScrapeRuns, scrapeOutputUrl, startScrapeRun, type ScrapeRun, type ScrapeRuns,
} from '../lib/admin'
import { when } from './shared'

/** How often the history is re-read while a run is queued or running. */
const POLL_MS = 10_000

const STATUS_TONE: Record<ScrapeRun['status'], 'neutral' | 'accent' | 'success' | 'danger'> = {
  queued: 'neutral', running: 'accent', succeeded: 'success', failed: 'danger',
}

/**
 * The scrapers (#111's runner, migration 0015). "Run now" asks GitHub to
 * start the workflow on the self-hosted runner; what comes back is a row per
 * run with each scraper's verdict, because the runner reports here rather
 * than into an artifact store the account cannot use. Drafts only: the
 * number that matters afterwards is how many imported drafts are waiting,
 * and the link goes straight to them.
 */
export function ScrapersPanel() {
  const [runs, setRuns] = useState<ScrapeRuns | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setRuns(await fetchScrapeRuns())
      setLoadError(null)
    } catch (caught) {
      setLoadError(caught instanceof AuthorError ? caught.message : 'Could not load the run history')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const active = runs?.data.some((run) => run.status === 'queued' || run.status === 'running') ?? false
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [active, load])

  const latest = runs?.data[0] ?? null
  const pending = runs?.pending_imports ?? 0

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      await startScrapeRun()
      await load()
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'That did not work')
    } finally {
      setStarting(false)
    }
  }

  return (
    <section className="admin__section" aria-labelledby="admin-heading">
      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}
      <Card raised className="admin__job">
        <div className="admin__row-body">
          <h2 className="admin__row-title">Scrape the sources</h2>
          <p className="board__meta">
            Runs every morning at six, Kathmandu time, on the runner. Every source
            is read and what is new goes into the queue as drafts; nothing is
            published by a run.
          </p>

          {loadError && <Alert tone="danger" title="History unavailable">{loadError}</Alert>}
          {runs && !runs.configured && (
            <Alert tone="info" title="Not wired up here">
              This environment has no token for starting a run. The nightly schedule still runs.
            </Alert>
          )}

          {pending > 0 && (
            <Alert tone="info" title={`${pending} imported ${pending === 1 ? 'draft is' : 'drafts are'} waiting`}>
              <Link href="/admin/moderation?status=draft&source=import">Review and publish them</Link>
            </Alert>
          )}

          {runs && runs.data.length === 0 && (
            <p className="board__meta">No runs recorded yet.</p>
          )}
          {runs && runs.data.length > 0 && (
            <ol className="admin__runs" aria-label="Recent runs">
              {runs.data.slice(0, 6).map((run) => <RunRow key={run.id} run={run} />)}
            </ol>
          )}
        </div>
        <div className="admin__row-actions">
          <Button type="button" loading={starting} disabled={starting || active || runs?.configured === false}
                  onClick={() => void start()}>
            {active ? (latest?.status === 'queued' ? 'Queued…' : 'Running…') : 'Run now'}
          </Button>
        </div>
      </Card>
    </section>
  )
}

function RunRow({ run }: { run: ScrapeRun }) {
  const jobs = run.summary?.jobs ?? []
  const failed = jobs.filter((job) => !job.success)
  return (
    <li className="admin__run">
      <div className="admin__run-head">
        <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
        <span className="admin__run-when">{when(run.requested_at)}</span>
        <span className="board__meta">
          {run.trigger === 'schedule' ? 'scheduled' : `started by ${run.requested_by_name ?? 'an admin'}`}
          {run.apply_env ? ` · drafts into ${run.apply_env}` : ' · scrape only'}
        </span>
      </div>
      {jobs.length > 0 && (
        <ul className="admin__run-jobs" aria-label="Scrapers">
          {jobs.map((job) => (
            <li key={job.name} className={`admin__run-job${job.success ? '' : job.skipped ? ' is-skipped' : ' is-failed'}`}
                title={job.error ?? undefined}>
              {job.success ? '✓' : job.skipped ? '–' : '✕'} {job.name}
              {job.import?.new_drafts ? ` (${job.import.new_drafts} new)` : ''}
            </li>
          ))}
        </ul>
      )}
      <div className="admin__run-foot">
        {run.status === 'succeeded' || run.status === 'failed' ? (
          <span className="board__meta">
            {run.drafts_created} {run.drafts_created === 1 ? 'draft' : 'drafts'} created
            {failed.length > 0 && ` · ${failed.map((job) => job.name).join(', ')} failed`}
          </span>
        ) : null}
        {run.error && run.status === 'failed' && failed.length === 0 && (
          <span className="board__meta">{run.error}</span>
        )}
        {run.output_key && <a href={scrapeOutputUrl(run.id)}>Download output</a>}
        {run.github_run_url && (
          <a href={run.github_run_url} target="_blank" rel="noreferrer">Runner log</a>
        )}
      </div>
    </li>
  )
}
