import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../components/primitives'
import {
  AuthorError, archiveListing, duplicateListing, fetchAccount, fetchDashboard,
  publishListing, submitListing,
  type Account, type Dashboard, type DashboardListing,
} from '../lib/author'
import { navigate } from '../router'
import { browserStorage, clearDraft, listLocalDrafts, type StoredDraft } from './draftStore'

/**
 * The organizer dashboard (#34): everything you have listed, what state it is
 * in, and whether anybody looked.
 *
 * **The counts are the point.** An organizer who can see that 400 people
 * looked at their listing has a reason to post the next one; one who sees
 * nothing has no reason to come back. That is why views and clicks are on the
 * row rather than behind an "analytics" tab, and why the click-through is
 * shown next to them — views alone say the listing was found, and the ratio is
 * the part that says whether it worked.
 *
 * **Quick actions do not navigate.** The criterion says so, and the reason is
 * that the normal shape of this screen is housekeeping across several rows:
 * archive last month's, duplicate the one that goes monthly, publish the one
 * that came back approved. Each of those bouncing through a page load turns
 * five seconds of work into a minute of waiting.
 */

const TABS = [
  { status: undefined, label: 'Everything' },
  { status: 'draft', label: 'Drafts' },
  { status: 'pending_review', label: 'In review' },
  { status: 'published', label: 'Published' },
  { status: 'rejected', label: 'Sent back' },
  { status: 'archived', label: 'Archived' },
] as const

const STATUS_LABELS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending_review: { label: 'In review', tone: 'accent' },
  published: { label: 'Published', tone: 'success' },
  rejected: { label: 'Sent back', tone: 'warning' },
  archived: { label: 'Archived', tone: 'neutral' },
}

export function DashboardPage() {
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

  if (!account) {
    return (
      <Card raised>
        <h1>Sign in to see your listings</h1>
        <p>Your drafts and published events live here once you have an account.</p>
        <Button onClick={() => navigate('/submit')}>Sign in</Button>
      </Card>
    )
  }

  if (!account.permissions.includes('listing:edit_own')) {
    return (
      <Card raised>
        <h1>Nothing here yet</h1>
        <p>
          Your account cannot add listings. Organizer accounts can; ask an editor
          to upgrade yours.
        </p>
      </Card>
    )
  }

  return <Listings account={account} />
}

function Listings({ account }: { account: Account }) {
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [board, setBoard] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const storage = useMemo(() => browserStorage(), [])
  const [locals, setLocals] = useState<{ id: string | null; draft: StoredDraft }[]>([])
  useEffect(() => { setLocals(listLocalDrafts(storage)) }, [storage])

  const load = useCallback(async (which: string | undefined, search: string) => {
    setLoading(true)
    setError(null)
    try {
      setBoard(await fetchDashboard({ status: which, query: search }))
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'Your listings did not load')
    } finally {
      setLoading(false)
    }
  }, [])

  // Debounced, so typing a title is one request rather than one per letter.
  useEffect(() => {
    const timer = setTimeout(() => void load(status, query.trim()), query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [status, query, load])

  const act = async (id: string, what: 'publish' | 'archive' | 'duplicate') => {
    setBusyId(id)
    setNote(null)
    setError(null)
    try {
      if (what === 'duplicate') {
        const copy = await duplicateListing(id)
        // Straight into the wizard: the copy exists to be edited, and the one
        // thing certainly wrong with it is the date, which was cleared.
        navigate(`/submit/${copy.id}`)
        return
      }
      if (what === 'archive') {
        await archiveListing(id)
        setNote('Archived.')
      } else {
        // An organizer's own listing still goes through review; the API
        // refuses draft → published, so this is submit and then, for anyone
        // who may publish, publish.
        const submitted = await submitListing(id)
        if (account.permissions.includes('listing:publish')) {
          await publishListing(submitted.id)
          setNote('Published.')
        } else {
          setNote('Sent for review. An editor will look at it shortly.')
        }
      }
      await load(status, query.trim())
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'That did not work')
    } finally {
      setBusyId(null)
    }
  }

  const rows = board?.data ?? []
  const total = Object.values(board?.counts ?? {}).reduce((sum, n) => sum + n, 0)
  const searching = query.trim() !== '' || status !== undefined

  return (
    <div className="board">
      <header className="board__header">
        <div>
          <h1>Your listings</h1>
          <p className="board__signed-in">Signed in as {account.email}</p>
        </div>
        <div className="board__header-actions">
          {account.permissions.includes('listing:moderate') && (
            <Button variant="ghost" onClick={() => navigate('/moderate')}>
              Moderation queue
            </Button>
          )}
          <Button onClick={() => navigate('/submit')}>Add a listing</Button>
        </div>
      </header>

      {/* The unfinished-work entry point (#34). A draft abandoned on a phone is
          only offered back by the wizard on the page it belongs to, which is
          the page that author is not going to open again. */}
      {locals.length > 0 && (
        <Alert tone="info" title="Unfinished on this device">
          <ul className="board__locals">
            {locals.map(({ id, draft }) => (
              <li key={id ?? 'new'}>
                <span>{draft.listing.title || 'Untitled draft'}</span>
                <span className="board__meta">
                  saved {new Date(draft.savedAt).toLocaleDateString('en-GB')}
                </span>
                <Button size="sm" variant="secondary"
                        onClick={() => navigate(id ? `/submit/${id}` : '/submit')}>
                  Pick it up
                </Button>
                <Button size="sm" variant="ghost" onClick={() => {
                  clearDraft(storage, id)
                  setLocals(listLocalDrafts(storage))
                }}>
                  Discard
                </Button>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {note && <Alert tone="success" title="Done">{note}</Alert>}
      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <div className="board__controls">
        <nav className="board__tabs" aria-label="Listings by state">
          {TABS.map((tab) => (
            <button key={tab.label} type="button"
                    className={`queue__tab${status === tab.status ? ' is-current' : ''}`}
                    aria-current={status === tab.status ? 'true' : undefined}
                    onClick={() => setStatus(tab.status)}>
              {tab.label}
              <span className="queue__count">
                {tab.status ? board?.counts[tab.status] ?? 0 : total}
              </span>
            </button>
          ))}
        </nav>

        <Field label="Search your listings">
          {({ id }) => (
            <Input id={id} type="search" placeholder="Title…" value={query}
                   onChange={(event) => setQuery(event.target.value)} />
          )}
        </Field>
      </div>

      {loading && <div className="wizard__loading"><Spinner label="Loading your listings" /></div>}

      {/* The empty state has one job: get a first-time organizer into the
          wizard. A "no results" box that also appears when a search misses
          would send somebody who has fifty listings to the create form. */}
      {!loading && rows.length === 0 && (
        <Card raised className="board__empty">
          {total === 0 && !searching ? (
            <>
              <h2>Nothing listed yet</h2>
              <p>
                Put on a gig, a screening, a clean-up, a festival — anything
                happening around you belongs here. It takes about two minutes.
              </p>
              <Button onClick={() => navigate('/submit')}>Add your first listing</Button>
            </>
          ) : (
            <>
              <h2>Nothing matches</h2>
              <p>Try a different search, or another tab.</p>
            </>
          )}
        </Card>
      )}

      {rows.length > 0 && (
        <ul className="board__list">
          {rows.map((listing) => (
            <li key={listing.id}>
              <ListingRow listing={listing} busy={busyId === listing.id}
                          onAct={(what) => void act(listing.id, what)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ListingRow({ listing, busy, onAct }: {
  listing: DashboardListing
  busy: boolean
  onAct: (what: 'publish' | 'archive' | 'duplicate') => void
}) {
  const badge = STATUS_LABELS[listing.status] ?? { label: listing.status, tone: 'neutral' as const }
  const when = listing.starts_at
    ? new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kathmandu',
      }).format(new Date(listing.starts_at))
    : 'No date yet'

  return (
    <Card className="board__row">
      <div className="board__row-body">
        <h2 className="board__title">{listing.title || 'Untitled'}</h2>
        <p className="board__meta">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {when}
          {listing.venue_name && <> · {listing.venue_name}</>}
        </p>
        {listing.rejection_reason && (
          <Alert tone="warning" title="An editor sent this back">
            {listing.rejection_reason}
          </Alert>
        )}
      </div>

      {/* Counts only where they mean something. A draft nobody can see has
          nought views, and printing that reads as a failure rather than as the
          absence of a public page. */}
      {listing.status === 'published' || listing.status === 'archived' ? (
        <dl className="board__stats">
          <div><dt>Views</dt><dd>{listing.views.toLocaleString('en-GB')}</dd></div>
          <div><dt>Clicks</dt><dd>{listing.clicks.toLocaleString('en-GB')}</dd></div>
          <div>
            <dt>Click-through</dt>
            <dd>{listing.views > 0
              ? `${Math.round((listing.clicks / listing.views) * 100)}%`
              : '—'}</dd>
          </div>
        </dl>
      ) : (
        <p className="board__stats-empty">Counts start once it is published.</p>
      )}

      <div className="board__actions">
        <Button size="sm" variant="ghost" onClick={() => navigate(`/submit/${listing.id}`)}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" loading={busy} onClick={() => onAct('duplicate')}>
          Duplicate
        </Button>
        {(listing.status === 'draft' || listing.status === 'rejected') && (
          <Button size="sm" loading={busy} onClick={() => onAct('publish')}>
            {listing.status === 'rejected' ? 'Send again' : 'Publish'}
          </Button>
        )}
        {(listing.status === 'draft' || listing.status === 'published') && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => onAct('archive')}>
            Archive
          </Button>
        )}
      </div>
    </Card>
  )
}
