import { useState } from 'react'
import { Alert, Button, Card } from '../components/primitives'
import { AuthorError } from '../lib/author'
import { runArchive, sweepMedia, type Sweep } from '../lib/admin'

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
  const [busy, setBusy] = useState<'archive' | 'sweep' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (which: 'archive' | 'sweep', work: () => Promise<void>) => {
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
    <section className="admin__section" aria-labelledby="admin-heading">

      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <Card raised className="admin__job">
        <div className="admin__row-body">
          <h2 className="admin__row-title">Archive finished listings</h2>
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
          <h2 className="admin__row-title">Sweep orphaned media</h2>
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
