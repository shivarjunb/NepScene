import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Field, Modal, Spinner, Textarea } from '../components/primitives'
import {
  AuthorError, fetchAccount, fetchQueue, mergeListing, moderate,
  type Account, type Queue, type QueueEntry, type Refusal,
} from '../lib/author'
import { ListingWizard, type WizardOutcome } from '../author/ListingWizard'

/**
 * The moderation queue (#33) — the screen an editor works through.
 *
 * Two decisions shape it. **The duplicate flag is on the row**, not behind a
 * click: the whole point of detecting duplicates at submission is that the
 * person about to approve both can see it, and a warning that needs a second
 * screen is a warning nobody reads. And **rejection is a form, not a button**:
 * the API refuses a rejection with no reason (`reason_required`), because the
 * author sees the sentence verbatim and "rejected" on its own tells them
 * nothing they can act on.
 *
 * Selection is per row with one bulk bar, rather than an action menu per row.
 * The queue's normal shape is a run of obvious decisions with one or two that
 * need thought, and clearing the obvious ones in a single action is what makes
 * the rest visible.
 *
 * **A refusal is a dialog, and editing happens in one too.** The first pass
 * folded "1 could not move: A listing cannot go from draft to published" into
 * the success banner, which told the editor two state names and sent them to
 * `/submit/:id` to guess at the rest. Now the refused listings are named, the
 * fields to fix are listed, and Edit opens the wizard over the queue — the
 * queue is the editor's place of work, and a fix is a detour from it, not a
 * destination.
 */

const TABS = [
  { status: 'pending_review', label: 'Waiting' },
  { status: 'rejected', label: 'Rejected' },
  { status: 'published', label: 'Published' },
  { status: 'draft', label: 'Drafts' },
  { status: 'archived', label: 'Archived' },
] as const

export function QueuePage() {
  const [account, setAccount] = useState<Account | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    void fetchAccount().then((found) => {
      setAccount(found)
      setChecking(false)
    })
  }, [])

  if (checking) {
    return <div className="wizard__loading"><Spinner label="Checking your account" /></div>
  }

  if (!account?.permissions.includes('listing:moderate')) {
    return (
      <Card raised>
        <h1>Not for this account</h1>
        <p>
          The moderation queue is for editors. If you are looking for your own
          listings, they are on <a href="/dashboard">your dashboard</a>.
        </p>
      </Card>
    )
  }

  return <Queue account={account} />
}

function Queue({ account }: { account: Account }) {
  const [status, setStatus] = useState<string>('pending_review')
  const [queue, setQueue] = useState<Queue | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<string[] | null>(null)
  /** What the last action could not do, shown until the editor has read it. */
  const [refused, setRefused] = useState<{ action: string; rows: Refusal[] } | null>(null)
  /** The listing open in the editor dialog, if any. */
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null)

  const load = useCallback(async (which: string) => {
    setLoading(true)
    setError(null)
    try {
      setQueue(await fetchQueue(which))
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'The queue did not load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setSelected(new Set())
    void load(status)
  }, [status, load])

  const apply = async (action: 'publish' | 'archive' | 'reject', ids: string[], reason?: string) => {
    setBusy(true)
    setNote(null)
    setRefused(null)
    try {
      const result = await moderate(action, ids, reason)
      // The part that worked is a banner; the part that did not is a dialog.
      // An editor who selected forty and got one refused needs to know which
      // one and what to do about it, not to discover it later in the queue
      // they thought they had cleared.
      if (result.applied.length > 0) {
        setNote(`${result.applied.length} ${result.applied.length === 1 ? 'listing' : 'listings'} ${result.status}.`)
      }
      if (result.refused.length > 0) setRefused({ action, rows: result.refused })
      setRejecting(null)
      setSelected(new Set())
      await load(status)
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'That did not work')
    } finally {
      setBusy(false)
    }
  }

  const merge = async (entry: QueueEntry) => {
    if (!entry.duplicate) return
    setBusy(true)
    try {
      await mergeListing(entry.id, entry.duplicate.id)
      setNote(`Merged into “${entry.duplicate.title}”.`)
      await load(status)
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'The merge did not work')
    } finally {
      setBusy(false)
    }
  }

  const finishedEditing = async (outcome: WizardOutcome) => {
    const title = editing?.title || 'The listing'
    setEditing(null)
    setRefused(null)
    setNote(outcome.status === 'published'
      ? `“${title}” is published.`
      : `“${title}” is waiting for review.`)
    await load(status)
  }

  const closeEditor = () => {
    const closed = editing?.id
    setEditing(null)
    // The one just looked at leaves the refusal list; the rest come back.
    setRefused((current) => {
      if (!current) return null
      const rows = current.rows.filter((row) => row.id !== closed)
      return rows.length > 0 ? { ...current, rows } : null
    })
    // Autosave may have landed changes, and the row should say so.
    void load(status)
  }

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const rows = queue?.data ?? []
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id))

  return (
    <div className="queue">
      <header className="queue__header">
        <h1>Moderation queue</h1>
        <p className="queue__signed-in">Signed in as {account.email}</p>
      </header>

      <nav className="queue__tabs" aria-label="Listings by state">
        {TABS.map((tab) => (
          <button key={tab.status} type="button"
                  className={`queue__tab${status === tab.status ? ' is-current' : ''}`}
                  aria-current={status === tab.status ? 'true' : undefined}
                  onClick={() => setStatus(tab.status)}>
            {tab.label}
            {queue?.counts[tab.status] !== undefined && (
              <span className="queue__count">{queue.counts[tab.status]}</span>
            )}
          </button>
        ))}
      </nav>

      {note && <Alert tone="success" title="Done">{note}</Alert>}
      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      {/* Never both at once: two focus traps fight over Tab. The refusals
          come back, minus the one just opened, when the editor closes. */}
      {refused && !editing && (
        <RefusalDialog
          action={refused.action}
          rows={refused.rows}
          onClose={() => setRefused(null)}
          onEdit={(row) => setEditing({ id: row.id, title: row.title ?? '' })}
        />
      )}

      {editing && (
        <Modal open size="lg" title={editing.title || 'Untitled listing'} onClose={closeEditor}>
          <ListingWizard account={account} listingId={editing.id}
                         onFinished={(outcome) => void finishedEditing(outcome)} />
        </Modal>
      )}

      {rejecting && (
        <RejectionForm
          count={rejecting.length}
          busy={busy}
          onCancel={() => setRejecting(null)}
          onSend={(reason) => void apply('reject', rejecting, reason)}
        />
      )}

      {selected.size > 0 && !rejecting && (
        <div className="queue__bulk" role="group" aria-label="Actions for the selected listings">
          <span>{selected.size} selected</span>
          <Button type="button" size="sm" loading={busy}
                  onClick={() => void apply('publish', [...selected])}>
            Publish
          </Button>
          <Button type="button" size="sm" variant="secondary"
                  onClick={() => setRejecting([...selected])}>
            Reject…
          </Button>
          <Button type="button" size="sm" variant="ghost" loading={busy}
                  onClick={() => void apply('archive', [...selected])}>
            Archive
          </Button>
        </div>
      )}

      {loading && <div className="wizard__loading"><Spinner label="Loading the queue" /></div>}

      {!loading && rows.length === 0 && (
        <Card>
          <p className="queue__empty">
            {status === 'pending_review'
              ? 'Nothing is waiting. The queue is clear.'
              : 'Nothing here.'}
          </p>
        </Card>
      )}

      {rows.length > 0 && (
        <>
          <label className="queue__select-all">
            <input type="checkbox" checked={allSelected}
                   onChange={() => setSelected(allSelected
                     ? new Set()
                     : new Set(rows.map((row) => row.id)))} />
            Select everything on this page
          </label>

          <ul className="queue__list">
            {rows.map((entry) => (
              <li key={entry.id}>
                <QueueRow
                  entry={entry}
                  selected={selected.has(entry.id)}
                  busy={busy}
                  onToggle={() => toggle(entry.id)}
                  onEdit={() => setEditing({ id: entry.id, title: entry.title })}
                  onPublish={() => void apply('publish', [entry.id])}
                  onReject={() => setRejecting([entry.id])}
                  onMerge={() => void merge(entry)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** The states an editor may publish from — the API's `publish.from`, mirrored. */
const PUBLISHABLE = ['draft', 'pending_review', 'rejected']

function QueueRow({ entry, selected, busy, onToggle, onEdit, onPublish, onReject, onMerge }: {
  entry: QueueEntry
  selected: boolean
  busy: boolean
  onToggle: () => void
  onEdit: () => void
  onPublish: () => void
  onReject: () => void
  onMerge: () => void
}) {
  const when = entry.starts_at
    ? new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kathmandu',
      }).format(new Date(entry.starts_at))
    : 'No date yet'

  return (
    <Card className={`queue__row${entry.duplicate ? ' queue__row--flagged' : ''}`}>
      <div className="queue__row-main">
        <label className="queue__pick">
          <input type="checkbox" checked={selected} onChange={onToggle}
                 aria-label={`Select “${entry.title}”`} />
        </label>

        <div className="queue__row-body">
          <h2 className="queue__title">{entry.title || 'Untitled'}</h2>
          <p className="queue__meta">
            {when}
            {entry.venue_name && <> · {entry.venue_name}</>}
            {' · '}
            {entry.organization_name ?? entry.author?.email ?? 'Unknown author'}
          </p>
          <p className="queue__meta">
            <Badge tone={entry.source === 'submission' ? 'warning' : 'neutral'}>
              {entry.source}
            </Badge>
            {entry.category_slugs.map((slug) => <Badge key={slug}>{slug}</Badge>)}
            {entry.media_count === 0 && <Badge tone="warning">No picture</Badge>}
          </p>

          {entry.duplicate && (
            <Alert tone="warning" title="This may already be in the catalogue">
              <p>
                Looks like <a href={`/listings/${entry.duplicate.slug}`}>{entry.duplicate.title}</a>
                {entry.duplicate.score !== null && (
                  <> — {Math.round(entry.duplicate.score * 100)}% match</>
                )}
                .
              </p>
              <Button type="button" size="sm" variant="secondary" loading={busy}
                      onClick={onMerge}>
                Merge into it
              </Button>
            </Alert>
          )}
        </div>
      </div>

      <div className="queue__row-actions">
        <Button type="button" size="sm" variant="ghost" onClick={onEdit}>Edit</Button>
        {PUBLISHABLE.includes(entry.status) && (
          <Button type="button" size="sm" loading={busy} onClick={onPublish}>Publish</Button>
        )}
        {entry.status === 'pending_review' && (
          <Button type="button" size="sm" variant="secondary" onClick={onReject}>
            Reject…
          </Button>
        )}
      </div>
    </Card>
  )
}

/**
 * Rejection is a form because the reason is not optional — the API refuses
 * without one, and the author reads what is typed here word for word.
 */
function RejectionForm({ count, busy, onCancel, onSend }: {
  count: number
  busy: boolean
  onCancel: () => void
  onSend: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const tooShort = reason.trim().length < 10

  return (
    <Card raised className="queue__reject">
      <h2>Why is {count === 1 ? 'this' : `each of these ${count}`} coming back?</h2>
      <Field label="Reason"
             hint="The author sees this exactly as written. Say what they should change."
             error={tooShort && reason.length > 0 ? 'A sentence, not a word' : undefined}>
        {({ id, describedBy, invalid }) => (
          <Textarea id={id} rows={3} value={reason} autoFocus
                    aria-describedby={describedBy} aria-invalid={invalid || undefined}
                    onChange={(event) => setReason(event.target.value)} />
        )}
      </Field>
      <div className="queue__reject-actions">
        <Button type="button" loading={busy} disabled={tooShort}
                onClick={() => onSend(reason.trim())}>
          Send it back
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  )
}

/** The verb, past tense, for the dialog's title. */
const DONE: Record<string, string> = { publish: 'published', reject: 'rejected', archive: 'archived' }

/**
 * What the last action could not do, listing by listing.
 *
 * Each row carries the reason the API gave and, when the reason is "it is not
 * finished", the fields — the same per-field sentences the wizard shows, so an
 * editor reads here exactly what they will be asked to fix there. Edit opens
 * the wizard over the queue on that listing.
 */
function RefusalDialog({ action, rows, onClose, onEdit }: {
  action: string
  rows: Refusal[]
  onClose: () => void
  onEdit: (row: Refusal) => void
}) {
  const verb = DONE[action] ?? action
  const title = rows.length === 1
    ? `This one could not be ${verb}`
    : `${rows.length} could not be ${verb}`

  return (
    <Modal open title={title} onClose={onClose}
           footer={<Button type="button" variant="secondary" onClick={onClose}>Close</Button>}>
      <ul className="queue__refusals">
        {rows.map((row) => (
          <li key={row.id} className="queue__refusal">
            <div className="queue__refusal-body">
              <h3 className="queue__refusal-title">{row.title || 'Untitled'}</h3>
              <p className="queue__refusal-reason">{row.reason}</p>
              {row.fields && row.fields.length > 0 && (
                <ul className="wizard__error-list">
                  {row.fields.map((field) => (
                    <li key={`${field.field}-${field.message}`}>{field.message}</li>
                  ))}
                </ul>
              )}
            </div>
            {row.title !== null && (
              <Button type="button" size="sm" onClick={() => onEdit(row)}>Edit</Button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
