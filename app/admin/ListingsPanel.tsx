import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Spinner } from '../components/primitives'
import { AuthorError, moderate, type Account } from '../lib/author'
import {
  fetchListings, LISTING_STATUSES, type AdminListing, type ListingList, type ListingStatus,
} from '../lib/admin'
import { ListingWizard } from '../author/ListingWizard'
import { Link } from '../router'
import { Pager, when } from './shared'

/**
 * All listings: every state, one search box.
 *
 * The queue is a to-do list — oldest waiting first, and it forgets a listing
 * the moment it is decided. This is the other question: *where is it?* The
 * listing somebody emailed about, the import that came in twice, the one
 * archived by mistake. So it searches every state at once, newest change
 * first, and a row's actions are the queue's own: Publish and Archive go
 * through the same bulk endpoint, and Edit opens the same wizard over the
 * list rather than sending the editor away from it.
 */

const STATUS_LABEL: Record<ListingStatus, string> = {
  pending_review: 'Waiting', published: 'Published', draft: 'Draft', rejected: 'Sent back', archived: 'Archived',
}

const STATUS_TONE: Record<ListingStatus, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  pending_review: 'warning', published: 'success', draft: 'neutral', rejected: 'danger', archived: 'neutral',
}

const SOURCES = [
  { value: '', label: 'Any source' },
  { value: 'organizer', label: 'Organizers' },
  { value: 'submission', label: 'Public submissions' },
  { value: 'import', label: 'Scraper imports' },
  { value: 'editorial', label: 'Editorial' },
] as const

/** The API's `publish.from` and `archive.from`, mirrored so a button is only offered where it will work. */
const PUBLISHABLE: ListingStatus[] = ['draft', 'pending_review', 'rejected']
const ARCHIVABLE: ListingStatus[] = ['draft', 'published']

export function ListingsPanel({ account }: { account: Account }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<ListingStatus | ''>('')
  const [source, setSource] = useState('')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<ListingList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<AdminListing | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setList(await fetchListings({
        q: query.trim(), status: status || undefined, source: source || undefined, offset,
      }))
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'The listings did not load')
    } finally {
      setLoading(false)
    }
  }, [query, status, source, offset])

  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, query])

  const act = async (row: AdminListing, action: 'publish' | 'archive') => {
    setBusyId(row.id)
    setNote(null)
    setError(null)
    try {
      const result = await moderate(action, [row.id])
      const refusal = result.refused[0]
      if (refusal) {
        const fields = refusal.fields?.map((field) => field.message).join('; ')
        setError(`“${row.title || 'Untitled'}”: ${refusal.reason}${fields ? ` — ${fields}` : ''}`)
      } else {
        setNote(`“${row.title || 'Untitled'}” is ${result.status}.`)
      }
      await load()
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'That did not work')
    } finally {
      setBusyId(null)
    }
  }

  const rows = list?.data ?? []
  const total = LISTING_STATUSES.reduce((sum, s) => sum + (list?.counts[s] ?? 0), 0)

  return (
    <section className="admin__section" aria-labelledby="admin-heading">
      {note && <Alert tone="success" title="Done">{note}</Alert>}
      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <div className="board__controls">
        <nav className="board__tabs" aria-label="Listings by state">
          <button type="button" className={`queue__tab${status === '' ? ' is-current' : ''}`}
                  aria-current={status === '' ? 'true' : undefined}
                  onClick={() => { setStatus(''); setOffset(0) }}>
            All <span className="queue__count">{total}</span>
          </button>
          {LISTING_STATUSES.map((which) => (
            <button key={which} type="button"
                    className={`queue__tab${status === which ? ' is-current' : ''}`}
                    aria-current={status === which ? 'true' : undefined}
                    onClick={() => { setStatus(which); setOffset(0) }}>
              {STATUS_LABEL[which]} <span className="queue__count">{list?.counts[which] ?? 0}</span>
            </button>
          ))}
        </nav>

        <div className="admin__filters">
          <Field label="Find a listing">
            {({ id }) => (
              <Input id={id} type="search" placeholder="Title or web address…" value={query}
                     onChange={(event) => { setQuery(event.target.value); setOffset(0) }} />
            )}
          </Field>
          <Field label="Source">
            {({ id }) => (
              <Select id={id} value={source} onChange={(event) => { setSource(event.target.value); setOffset(0) }}>
                {SOURCES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            )}
          </Field>
        </div>
      </div>

      {loading && !list && <div className="wizard__loading"><Spinner label="Loading listings" /></div>}

      {!loading && rows.length === 0 && (
        <Card><p className="queue__empty">No listing matches.</p></Card>
      )}

      {rows.length > 0 && (
        <ul className="admin__list" aria-busy={loading}>
          {rows.map((row) => (
            <li key={row.id}>
              <Card className="admin__row">
                <div className="admin__row-body">
                  <h2 className="admin__row-title">
                    {row.title || 'Untitled'}
                    <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                    {row.source === 'import' && <Badge tone="neutral">imported</Badge>}
                  </h2>
                  <p className="board__meta">
                    {[
                      row.starts_at && when(row.starts_at, false),
                      row.venue_name,
                      row.organization_name,
                      row.author_email && `by ${row.author_email}`,
                    ].filter(Boolean).join(' · ')}
                  </p>
                  <p className="board__meta">Changed {when(row.updated_at)}</p>
                </div>
                <div className="admin__row-actions">
                  {row.status === 'published' && (
                    <Link className="btn btn--ghost btn--sm" href={`/listings/${row.slug}`}>View</Link>
                  )}
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(row)}>Edit</Button>
                  {ARCHIVABLE.includes(row.status) && (
                    <Button type="button" size="sm" variant="secondary" loading={busyId === row.id}
                            disabled={busyId !== null} onClick={() => void act(row, 'archive')}>
                      Archive
                    </Button>
                  )}
                  {PUBLISHABLE.includes(row.status) && (
                    <Button type="button" size="sm" loading={busyId === row.id}
                            disabled={busyId !== null} onClick={() => void act(row, 'publish')}>
                      Publish
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {list && <Pager page={list.page} count={rows.length} onPage={setOffset} />}

      {editing && (
        <Modal open size="lg" title={editing.title || 'Untitled listing'} onClose={() => { setEditing(null); void load() }}>
          <ListingWizard account={account} listingId={editing.id}
                         onFinished={(outcome) => {
                           setNote(`“${editing.title || 'The listing'}” is ${outcome.status === 'published' ? 'published' : 'waiting for review'}.`)
                           setEditing(null)
                           void load()
                         }} />
        </Modal>
      )}
    </section>
  )
}
