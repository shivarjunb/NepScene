import { useEffect, useState } from 'react'
import { Alert, Card, Spinner } from '../components/primitives'
import { AuthorError, fetchAccount, type Account } from '../lib/author'
import { fetchOverview, ROLES, type Overview } from '../lib/admin'
import { Link, navigate } from '../router'
import { AuditRow } from './shared'
import { UsersPanel } from './UsersPanel'
import { OrganizationsPanel } from './OrganizationsPanel'
import { AuditPanel } from './AuditPanel'
import { SystemPanel } from './SystemPanel'

/**
 * The admin console (#28), at /admin.
 *
 * **Five screens, each of which knows what it is for.** WaahTickets' admin
 * was one 4,800-line component rendering a generic grid over thirty tables;
 * every screen was the same screen, and none of them could say what a row
 * meant or what to do about it. This one has a screen per question — who can
 * do what, whose organization is whose, what happened, is the housekeeping
 * running — and hands listings to the screens that already exist for them.
 *
 * **Each screen is one round trip.** The API batches its statements and the
 * pages read one response; there is no per-row fetch anywhere here, which
 * from Kathmandu is the difference between a screen and a wait.
 *
 * The section is the URL (/admin/users, /admin/audit) so a screen can be
 * sent to someone, and so the Back button does what a person expects.
 */
const SECTIONS = [
  { slug: '', label: 'Overview' },
  { slug: 'users', label: 'Accounts' },
  { slug: 'organizations', label: 'Organizations' },
  { slug: 'audit', label: 'Audit trail' },
  { slug: 'system', label: 'Housekeeping' },
] as const

type Section = (typeof SECTIONS)[number]['slug']

export function AdminPage({ section }: { section: string }) {
  const [account, setAccount] = useState<Account | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    void fetchAccount().then((found) => {
      setAccount(found)
      setChecking(false)
    })
  }, [])

  if (checking) {
    return <div className="layout wizard__loading"><Spinner label="Checking your account" /></div>
  }

  if (!account?.permissions.includes('user:manage')) {
    return (
      <div className="layout">
        <Card raised>
          <h1>Not for this account</h1>
          <p>
            The admin console is for administrators. If you are looking for your
            own listings, they are on <Link href="/dashboard">your dashboard</Link>
            {account?.permissions.includes('listing:moderate') && (
              <>, and the <Link href="/moderate">moderation queue</Link> is where reviews happen</>
            )}.
          </p>
        </Card>
      </div>
    )
  }

  const known = SECTIONS.some((s) => s.slug === section)
  const current = (known ? section : '') as Section

  return (
    <div className="layout board admin">
      <header className="board__header">
        <div>
          <h1>Admin</h1>
          <p className="board__signed-in">Signed in as {account.email}</p>
        </div>
        <div className="board__header-actions">
          <Link className="btn btn--ghost btn--sm" href="/moderate">Moderation queue</Link>
          <Link className="btn btn--ghost btn--sm" href="/dashboard">Your listings</Link>
        </div>
      </header>

      <nav className="queue__tabs" aria-label="Admin sections">
        {SECTIONS.map((s) => (
          <Link key={s.slug} href={s.slug ? `/admin/${s.slug}` : '/admin'}
                className={`queue__tab${current === s.slug ? ' is-current' : ''}`}
                aria-current={current === s.slug ? 'page' : undefined}>
            {s.label}
          </Link>
        ))}
      </nav>

      {!known && (
        <Alert tone="warning" title="No such section">
          There is nothing at /admin/{section}; this is the overview.
        </Alert>
      )}

      {current === '' && <OverviewPanel />}
      {current === 'users' && <UsersPanel account={account} />}
      {current === 'organizations' && <OrganizationsPanel />}
      {current === 'audit' && <AuditPanel />}
      {current === 'system' && <SystemPanel />}
    </div>
  )
}

const LISTING_STATES = [
  { status: 'pending_review', label: 'Waiting for review' },
  { status: 'published', label: 'Published' },
  { status: 'draft', label: 'Drafts' },
  { status: 'rejected', label: 'Sent back' },
  { status: 'archived', label: 'Archived' },
] as const

/**
 * The numbers, and what happened last. The tiles are links: a count of
 * things waiting is a count someone wants to click.
 */
function OverviewPanel() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchOverview().then(setOverview, (caught: unknown) => {
      setError(caught instanceof AuthorError ? caught.message : 'The overview did not load')
    })
  }, [])

  if (error) return <Alert tone="danger" title="Something went wrong">{error}</Alert>
  if (!overview) return <div className="wizard__loading"><Spinner label="Loading the overview" /></div>

  const people = ROLES.reduce((sum, role) => sum + overview.users[role].total, 0)
  const inactive = ROLES.reduce((sum, role) => sum + overview.users[role].inactive, 0)

  return (
    <section className="admin__section" aria-labelledby="admin-overview">
      <h2 id="admin-overview" className="visually-hidden">Overview</h2>

      <div className="admin__tiles">
        <button type="button" className="admin__tile" onClick={() => navigate('/moderate')}>
          <span className="admin__tile-n">{overview.listings.pending_review ?? 0}</span>
          <span className="admin__tile-label">waiting for review</span>
        </button>
        <button type="button" className="admin__tile" onClick={() => navigate('/admin/users')}>
          <span className="admin__tile-n">{people}</span>
          <span className="admin__tile-label">
            {people === 1 ? 'account' : 'accounts'}
            {inactive > 0 && <>, {inactive} deactivated</>}
          </span>
        </button>
        <button type="button" className="admin__tile" onClick={() => navigate('/admin/organizations')}>
          <span className="admin__tile-n">{overview.organizations.total}</span>
          <span className="admin__tile-label">
            {overview.organizations.total === 1 ? 'organization' : 'organizations'}
            , {overview.organizations.verified} verified
          </span>
        </button>
      </div>

      <div className="admin__columns">
        <Card>
          <h3 className="admin__row-title">Accounts by role</h3>
          <dl className="admin__facts">
            {ROLES.map((role) => (
              <div key={role}>
                <dt>{role}</dt>
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
        <Card>
          <h3 className="admin__row-title">Listings by state</h3>
          <dl className="admin__facts">
            {LISTING_STATES.map((state) => (
              <div key={state.status}>
                <dt>{state.label}</dt>
                <dd>{overview.listings[state.status] ?? 0}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card className="admin__audit">
        <div className="admin__detail-head">
          <h3 className="admin__row-title">Recent activity</h3>
          <Link href="/admin/audit">The whole trail</Link>
        </div>
        {overview.recent.length === 0 && <p className="queue__empty">Nothing recorded yet.</p>}
        {overview.recent.map((entry) => <AuditRow key={entry.id} entry={entry} />)}
      </Card>
    </section>
  )
}
