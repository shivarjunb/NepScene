import { useState } from 'react'
import { Alert, Badge, Button, Card, Spinner } from '../components/primitives'
import { AuthorError, moderate } from '../lib/author'
import { ROLES, type Overview, type WaitingListing } from '../lib/admin'
import { Link } from '../router'
import { AuditRow, when } from './shared'

/**
 * The console's first screen: what is waiting, the numbers, and what
 * happened last.
 *
 * **What needs doing comes first.** The old overview was three counts and two
 * tables of numbers, and the only way to act on any of it was to leave. Now
 * the oldest listings waiting for review are here with a Publish button — the
 * obvious ones clear from the overview, and "Review" opens the queue for the
 * rest — and the organizations nobody has verified sit beside them.
 *
 * Every count is a link to the screen that acts on it: a count of things
 * waiting is a count someone wants to click.
 */

const LISTING_STATES = [
  { status: 'pending_review', label: 'Waiting', tone: 'waiting' },
  { status: 'published', label: 'Published', tone: 'published' },
  { status: 'draft', label: 'Drafts', tone: 'draft' },
  { status: 'rejected', label: 'Sent back', tone: 'rejected' },
  { status: 'archived', label: 'Archived', tone: 'archived' },
] as const

const ROLE_LABEL = { visitor: 'Visitors', organizer: 'Organizers', editor: 'Editors', admin: 'Admins' } as const

export function OverviewPanel({ overview, error, onChanged }: {
  overview: Overview | null
  error: string | null
  onChanged: () => Promise<void>
}) {
  if (error) return <Alert tone="danger" title="Something went wrong">{error}</Alert>
  if (!overview) return <div className="wizard__loading"><Spinner label="Loading the overview" /></div>

  const people = ROLES.reduce((sum, role) => sum + overview.users[role].total, 0)
  const inactive = ROLES.reduce((sum, role) => sum + overview.users[role].inactive, 0)
  const waiting = overview.listings.pending_review ?? 0
  const oldest = overview.waiting[0]
  const listed = LISTING_STATES.reduce((sum, state) => sum + (overview.listings[state.status] ?? 0), 0)
  const unverified = overview.organizations.total - overview.organizations.verified

  return (
    <section className="admin__section" aria-labelledby="admin-heading">
      <div className="admin__tiles">
        <Link href="/admin/moderation" className={`admin__tile${waiting > 0 ? ' admin__tile--waiting' : ''}`}>
          <span className="admin__tile-label">Waiting for review</span>
          <span className="admin__tile-n">{waiting}</span>
          <span className="admin__tile-note">
            {oldest ? `Oldest waiting ${age(oldest.updated_at)}` : 'The queue is clear'}
          </span>
        </Link>
        <Link href="/admin/moderation?status=published" className="admin__tile">
          <span className="admin__tile-label">Published</span>
          <span className="admin__tile-n">{overview.listings.published ?? 0}</span>
          <span className="admin__tile-note">{overview.listings.draft ?? 0} drafts in progress</span>
        </Link>
        <Link href="/admin/users" className="admin__tile">
          <span className="admin__tile-label">Accounts</span>
          <span className="admin__tile-n">{people}</span>
          <span className="admin__tile-note">
            {overview.users.organizer.total} {overview.users.organizer.total === 1 ? 'organizer' : 'organizers'}
            {inactive > 0 && <> · {inactive} deactivated</>}
          </span>
        </Link>
        <ScrapeTile run={overview.last_scrape} />
      </div>

      <div className="admin__columns">
        <Attention waiting={overview.waiting} total={waiting} unverified={unverified}
                   unmapped={overview.venues.unmapped} onChanged={onChanged} />

        <div className="admin__stack">
          <Card>
            <h2 className="admin__row-title">Listings by state</h2>
            {listed > 0 && (
              <div className="admin__bar" aria-hidden="true">
                {LISTING_STATES.map((state) => {
                  const n = overview.listings[state.status] ?? 0
                  return n > 0 && (
                    <span key={state.status} className={`admin__bar-part admin__bar-part--${state.tone}`}
                          style={{ flexGrow: n }} />
                  )
                })}
              </div>
            )}
            <dl className="admin__facts">
              {LISTING_STATES.map((state) => (
                <div key={state.status}>
                  <dt><span className={`admin__dot admin__bar-part--${state.tone}`} aria-hidden="true" />{state.label}</dt>
                  <dd>{overview.listings[state.status] ?? 0}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <h2 className="admin__row-title">Accounts by role</h2>
            <dl className="admin__roles">
              {ROLES.map((role) => (
                <div key={role}>
                  <dt>{ROLE_LABEL[role]}</dt>
                  <dd>
                    {overview.users[role].total}
                    {overview.users[role].inactive > 0 && (
                      <span className="board__meta"> ({overview.users[role].inactive} off)</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>

      <Card className="admin__audit">
        <div className="admin__detail-head">
          <h2 className="admin__row-title">Recent activity</h2>
          <Link href="/admin/audit">The whole audit trail</Link>
        </div>
        {overview.recent.length === 0 && <p className="queue__empty">Nothing recorded yet.</p>}
        {overview.recent.map((entry) => <AuditRow key={entry.id} entry={entry} />)}
      </Card>
    </section>
  )
}

/** The last scrape at a glance: when, and which scrapers did not finish. */
function ScrapeTile({ run }: { run: Overview['last_scrape'] }) {
  const jobs = run?.summary?.jobs ?? []
  const ran = jobs.filter((job) => !job.skipped)
  const failed = ran.filter((job) => !job.success)
  const bad = run?.status === 'failed' || failed.length > 0
  return (
    <Link href="/admin/scrapers" className={`admin__tile${bad ? ' admin__tile--failed' : ''}`}>
      <span className="admin__tile-label">Last scrape</span>
      {!run && <><span className="admin__tile-n">—</span><span className="admin__tile-note">No runs yet</span></>}
      {run && (
        <>
          <span className="admin__tile-n">
            {ran.length > 0 ? `${ran.length - failed.length} / ${ran.length}` : run.status}
          </span>
          <span className="admin__tile-note">
            {when(run.finished_at ?? run.requested_at)}
            {failed.length > 0 && <> · {failed.map((job) => job.name).join(', ')} failed</>}
            {failed.length === 0 && run.status === 'failed' && <> · failed</>}
          </span>
        </>
      )}
    </Link>
  )
}

/**
 * The head of the queue, actionable. Publishing goes through the same bulk
 * endpoint the queue uses, so a listing the API will not publish yet — no
 * date, no category — comes back with the reason, and the link to fix it.
 */
function Attention({ waiting, total, unverified, unmapped, onChanged }: {
  waiting: WaitingListing[]
  total: number
  unverified: number
  unmapped: number
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const publish = async (row: WaitingListing) => {
    setBusy(row.id)
    setNote(null)
    setProblem(null)
    try {
      const result = await moderate('publish', [row.id])
      const refusal = result.refused[0]
      if (refusal) setProblem(`“${row.title || 'Untitled'}” was not published: ${refusal.reason}`)
      else setNote(`“${row.title || 'Untitled'}” is published.`)
      await onChanged()
    } catch (caught) {
      setProblem(caught instanceof AuthorError ? caught.message : 'That did not work')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="admin__attention">
      <div className="admin__detail-head">
        <h2 className="admin__row-title">Needs your attention</h2>
        <Link href="/admin/moderation">Open the queue</Link>
      </div>

      {note && <Alert tone="success" title="Done">{note}</Alert>}
      {problem && <Alert tone="warning" title="Not published">{problem}</Alert>}

      {waiting.length === 0 && unverified === 0 && unmapped === 0 && (
        <p className="queue__empty">Nothing is waiting. The queue is clear.</p>
      )}

      <ul className="admin__waiting">
        {waiting.map((row) => (
          <li key={row.id} className="admin__waiting-row">
            <div className="admin__row-body">
              <h3 className="admin__waiting-title">
                {row.title || 'Untitled'}
                {row.has_duplicate && <Badge tone="warning">possible duplicate</Badge>}
                {row.source === 'import' && <Badge tone="neutral">imported</Badge>}
              </h3>
              <p className="board__meta">
                {[row.starts_at && when(row.starts_at, false), row.venue_name, row.organization_name]
                  .filter(Boolean).join(' · ')}
                {' · '}waiting {age(row.updated_at)}
              </p>
            </div>
            <div className="admin__row-actions">
              <Link className="btn btn--ghost btn--sm" href="/admin/moderation">Review</Link>
              <Button type="button" size="sm" loading={busy === row.id} disabled={busy !== null}
                      onClick={() => void publish(row)}>
                Publish
              </Button>
            </div>
          </li>
        ))}
        {unmapped > 0 && (
          <li className="admin__waiting-row">
            <div className="admin__row-body">
              <h3 className="admin__waiting-title">
                {unmapped} {unmapped === 1 ? 'venue has' : 'venues have'} no map pin
              </h3>
              <p className="board__meta">Nothing listed there can appear on the map until it has one.</p>
            </div>
            <div className="admin__row-actions">
              <Link className="btn btn--ghost btn--sm" href="/admin/venues?filter=unmapped">Fix</Link>
            </div>
          </li>
        )}
        {unverified > 0 && (
          <li className="admin__waiting-row">
            <div className="admin__row-body">
              <h3 className="admin__waiting-title">
                {unverified} {unverified === 1 ? 'organization is' : 'organizations are'} not verified
              </h3>
              <p className="board__meta">A verified badge is what tells a visitor the organizer is real.</p>
            </div>
            <div className="admin__row-actions">
              <Link className="btn btn--ghost btn--sm" href="/admin/organizations">Review</Link>
            </div>
          </li>
        )}
      </ul>

      {total > waiting.length && (
        <p className="board__meta">
          …and {total - waiting.length} more in <Link href="/admin/moderation">the queue</Link>.
        </p>
      )}
    </Card>
  )
}

/** "3 days", "5 hours", "a few minutes" — how long something has been waiting. */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return minutes < 5 ? 'a few minutes' : `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`
  const days = Math.round(hours / 24)
  return days === 1 ? '1 day' : `${days} days`
}
