import { useCallback, useEffect, useState } from 'react'
import { Link } from '../router'
import { Alert, Badge, Button, Card } from '../components/primitives'
import { AuthorError } from '../lib/author'
import {
  fetchScrapeRuns, runArchive, scrapeOutputUrl, startScrapeRun, sweepMedia,
  type ScrapeRun, type ScrapeRuns, type Sweep,
} from '../lib/admin'
import { when } from './shared'

/**
 * Housekeeping (#25, #33): the two jobs that run without anyone watching,
 * with a button for the afternoon someone would rather not wait.
 *
 * The media sweep is a dry run first, always. It deletes objects from R2,
 * which is the one thing in this console that cannot be undone from the
 * audit log, and an admin who can see the list before it goes is worth more
 * than a button that is one click faster.
 */
export function SystemPanel() {
  const [archive, setArchive] = useState<{ archived: number; scanned: number } | null>(null)
  const [sweep, setSweep] = useState<Sweep | null>(null)
  const [busy, setBusy] = useState<'archive' | 'sweep' | 'scrape' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (which: 'archive' | 'sweep' | 'scrape', work: () => Promise<void>) => {
    setBusy(which)
    setError(null)
    try {
      await work()
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'That did not work')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="admin__section" aria-labelledby="admin-system">
      <h2 id="admin-system">Housekeeping</h2>

      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <ScrapeCard busy={busy !== null} running={busy === 'scrape'}
                  onRun={(work) => run('scrape', work)} />

      <Card raised className="admin__job">
        <div className="admin__row-body">
          <h3 className="admin__row-title">Archive finished listings</h3>
          <p className="board__meta">
            Runs nightly at midnight Kathmandu. Anything published that ended more
            than a day ago is archived, a hundred at a time.
          </p>
          {archive && (
            <Alert tone={archive.archived > 0 ? 'success' : 'info'} title="Done">
              {archive.archived === 0
                ? 'Nothing had finished. The catalogue is current.'
                : `${archive.archived} ${archive.archived === 1 ? 'listing' : 'listings'} archived.`}
            </Alert>
          )}
        </div>
        <div className="admin__row-actions">
          <Button type="button" loading={busy === 'archive'} disabled={busy !== null}
                  onClick={() => void run('archive', async () => setArchive(await runArchive()))}>
            Run now
          </Button>
        </div>
      </Card>

      <Card raised className="admin__job">
        <div className="admin__row-body">
          <h3 className="admin__row-title">Sweep orphaned media</h3>
          <p className="board__meta">
            An upload that never became part of a listing stays in storage with
            nothing pointing at it. The check lists what would go; deleting is a
            second step.
          </p>
          {sweep && (
            <Alert tone={sweep.dry_run ? 'info' : 'success'}
                   title={sweep.dry_run ? 'What would be deleted' : 'Deleted'}>
              <p>
                {sweep.scanned} {sweep.scanned === 1 ? 'object' : 'objects'} in storage,
                {' '}{sweep.orphans} orphaned
                {!sweep.dry_run && <>, {sweep.deleted} deleted</>}.
              </p>
              {sweep.keys.length > 0 && (
                <ul className="admin__keys">
                  {sweep.keys.map((key) => <li key={key}><code>{key}</code></li>)}
                  {sweep.orphans > sweep.keys.length && (
                    <li>…and {sweep.orphans - sweep.keys.length} more</li>
                  )}
                </ul>
              )}
            </Alert>
          )}
        </div>
        <div className="admin__row-actions">
          <Button type="button" variant="secondary" loading={busy === 'sweep'} disabled={busy !== null}
                  onClick={() => void run('sweep', async () => setSweep(await sweepMedia(true)))}>
            Check
          </Button>
          {/* Only after a dry run found something: the delete button does
              not exist until there is a list to have read. */}
          {sweep?.dry_run && sweep.orphans > 0 && (
            <Button type="button" variant="danger" loading={busy === 'sweep'} disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm(`Delete ${sweep.orphans} orphaned ${sweep.orphans === 1 ? 'object' : 'objects'} from storage? This cannot be undone.`)) {
                        void run('sweep', async () => setSweep(await sweepMedia(false)))
                      }
                    }}>
              Delete {sweep.orphans}
            </Button>
          )}
        </div>
      </Card>
    </section>
  )
}

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
function ScrapeCard({ busy, running, onRun }: {
  busy: boolean
  running: boolean
  onRun: (work: () => Promise<void>) => Promise<void>
}) {
  const [runs, setRuns] = useState<ScrapeRuns | null>(null)
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

  return (
    <Card raised className="admin__job">
      <div className="admin__row-body">
        <h3 className="admin__row-title">Scrape the sources</h3>
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
            <Link href="/moderate?status=draft&source=import">Review and publish them</Link>
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
        <Button type="button" loading={running} disabled={busy || active || runs?.configured === false}
                onClick={() => void onRun(async () => { await startScrapeRun(); await load() })}>
          {active ? (latest?.status === 'queued' ? 'Queued…' : 'Running…') : 'Run now'}
        </Button>
      </div>
    </Card>
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
