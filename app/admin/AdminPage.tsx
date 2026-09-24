import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Alert, Card, Spinner } from '../components/primitives'
import { AuthorError, fetchAccount, type Account } from '../lib/author'
import { fetchOverview, type Overview } from '../lib/admin'
import { Link } from '../router'
import { ModerationPanel } from './ModerationPanel'
import { OverviewPanel } from './OverviewPanel'
import { UsersPanel } from './UsersPanel'
import { OrganizationsPanel } from './OrganizationsPanel'
import { AuditPanel } from './AuditPanel'
import { ScrapersPanel } from './ScrapersPanel'
import { SystemPanel } from './SystemPanel'

/**
 * The admin console (#28), at /admin — one place for everything an admin or
 * an editor does that a visitor does not.
 *
 * **One console, not three pages.** The console, the moderation queue and the
 * dashboard used to link to each other from buttons in each one's header, so
 * the way into admin was through "Your listings". Now the header's account
 * menu has one "Admin console" entry, and the console's own sidebar holds
 * every section: the queue is /admin/moderation, beside the accounts and the
 * scrapers, rather than a page of its own.
 *
 * **Each section says what it is for, and who it is for.** A section carries
 * the permission it needs, and the sidebar only shows what this account can
 * open: an editor sees Moderation and nothing else, and lands there, instead
 * of on an overview the API would refuse them.
 *
 * The section is the URL (/admin/users, /admin/audit) so a screen can be sent
 * to someone, and so the Back button does what a person expects.
 */

type Group = 'overview' | 'content' | 'people' | 'system'
type IconName = 'overview' | 'review' | 'people' | 'org' | 'audit' | 'scrape' | 'broom'

const SECTIONS = [
  { slug: '', label: 'Overview', group: 'overview', needs: 'user:manage', icon: 'overview' },
  { slug: 'moderation', label: 'Moderation', group: 'content', needs: 'listing:moderate', icon: 'review' },
  { slug: 'users', label: 'Accounts', group: 'people', needs: 'user:manage', icon: 'people' },
  { slug: 'organizations', label: 'Organizations', group: 'people', needs: 'user:manage', icon: 'org' },
  { slug: 'audit', label: 'Audit trail', group: 'system', needs: 'user:manage', icon: 'audit' },
  { slug: 'scrapers', label: 'Scrapers', group: 'system', needs: 'user:manage', icon: 'scrape' },
  { slug: 'system', label: 'Housekeeping', group: 'system', needs: 'user:manage', icon: 'broom' },
] as const satisfies readonly { slug: string; label: string; group: Group; needs: string; icon: IconName }[]

type Section = (typeof SECTIONS)[number]

/** `label` titles the group in the sidebar; `tab` names it in the phone's tab bar. */
const GROUPS: { id: Group; label: string | null; tab: string; icon: IconName }[] = [
  { id: 'overview', label: null, tab: 'Overview', icon: 'overview' },
  { id: 'content', label: 'Content', tab: 'Review', icon: 'review' },
  { id: 'people', label: 'People', tab: 'People', icon: 'people' },
  { id: 'system', label: 'System', tab: 'System', icon: 'scrape' },
]

const href = (section: Section) => (section.slug ? `/admin/${section.slug}` : '/admin')

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

  const visible = SECTIONS.filter((s) => account?.permissions.includes(s.needs))
  const landing = visible[0]
  if (!account || !landing) {
    return (
      <div className="layout">
        <Card raised>
          <h1>Not for this account</h1>
          <p>
            The admin console is for editors and administrators. If you are
            looking for your own listings, they are on{' '}
            <Link href="/dashboard">your dashboard</Link>.
          </p>
        </Card>
      </div>
    )
  }

  return <Console account={account} section={section} visible={visible} landing={landing} />
}

function Console({ account, section, visible, landing }: {
  account: Account
  section: string
  visible: Section[]
  /** The first section this account may open: where the root and a miss land. */
  landing: Section
}) {
  const canManage = account.permissions.includes('user:manage')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)

  // Read once for the whole console: the overview screen shows it, and the
  // sidebar's counts come from the same answer rather than a second request.
  const loadOverview = useCallback(async () => {
    if (!canManage) return
    try {
      setOverview(await fetchOverview())
      setOverviewError(null)
    } catch (caught) {
      setOverviewError(caught instanceof AuthorError ? caught.message : 'The overview did not load')
    }
  }, [canManage])

  useEffect(() => { void loadOverview() }, [loadOverview])

  const found = visible.find((s) => s.slug === section)
  const current = found ?? landing
  // The root is where an editor lands, so it is not "no such section" for them.
  const missing = !found && section !== ''
  const exists = SECTIONS.some((s) => s.slug === section)
  const group = GROUPS.find((g) => g.id === current.group)!
  const siblings = visible.filter((s) => s.group === current.group)

  const waiting = overview?.listings.pending_review ?? 0
  const unverified = overview ? overview.organizations.total - overview.organizations.verified : 0
  const scrapeFailed = overview?.last_scrape?.status === 'failed'
    || (overview?.last_scrape?.summary?.jobs.some((job) => !job.success && !job.skipped) ?? false)

  const extra = (s: Section) => {
    if (s.slug === 'moderation' && waiting > 0) {
      return <span className="console__count">{waiting}<span className="visually-hidden"> waiting</span></span>
    }
    if (s.slug === 'organizations' && unverified > 0) {
      return <span className="console__hint">{unverified} to verify</span>
    }
    if (s.slug === 'scrapers' && scrapeFailed) {
      return <span className="console__alarm" role="img" aria-label="the last run had a failure" />
    }
    return null
  }

  return (
    <div className="layout console">
      <aside className="console__rail">
        <div className="console__brand">
          <span className="console__mark" aria-hidden="true">N</span>
          <span className="console__brand-text">
            <span className="console__brand-name">NepScene</span>
            <span className="console__brand-sub">Admin console</span>
          </span>
        </div>

        <nav className="console__nav" aria-label="Admin sections">
          {GROUPS.map((g) => {
            const items = visible.filter((s) => s.group === g.id)
            if (items.length === 0) return null
            return (
              <div key={g.id} className="console__group">
                {g.label && <span className="console__group-label">{g.label}</span>}
                {items.map((s) => (
                  <Link key={s.slug} href={href(s)} className="console__link"
                        aria-current={s === current ? 'page' : undefined}>
                    <Icon name={s.icon} />
                    <span className="console__link-label">{s.label}</span>
                    {extra(s)}
                  </Link>
                ))}
              </div>
            )
          })}
        </nav>

        <div className="console__foot">
          <Link href="/" className="console__link">
            <Icon name="back" />
            <span className="console__link-label">Back to NepScene</span>
          </Link>
          <Link href="/dashboard" className="console__link">
            <Icon name="list" />
            <span className="console__link-label">My listings</span>
          </Link>
          <p className="console__who">
            <span className="console__who-name">{account.name ?? account.email}</span>
            <span className="console__who-role">{account.role}</span>
          </p>
        </div>
      </aside>

      <div className="console__main">
        <header className="console__header">
          <div>
            <p className="console__crumb">Admin{group.label && <> · {group.label}</>}</p>
            <h1 id="admin-heading" className="console__title">{current.label}</h1>
          </div>
          <Link className="btn btn--primary btn--sm" href="/submit">Add a listing</Link>
        </header>

        {/* On a phone the sidebar is gone: the tab bar picks the group and
            this strip picks the section within it. */}
        {siblings.length > 1 && (
          <nav className="console__subnav" aria-label={`${group.label ?? group.tab} sections`}>
            {siblings.map((s) => (
              <Link key={s.slug} href={href(s)} className="console__pill"
                    aria-current={s === current ? 'page' : undefined}>
                {s.label}
              </Link>
            ))}
          </nav>
        )}

        {missing && (
          <Alert tone="warning" title={exists ? 'Not for this account' : 'No such section'}>
            {exists
              ? <>/admin/{section} is for administrators; this is {current.label.toLowerCase()}.</>
              : <>There is nothing at /admin/{section}; this is {current.label.toLowerCase()}.</>}
          </Alert>
        )}

        {current.slug === '' && (
          <OverviewPanel overview={overview} error={overviewError} onChanged={loadOverview} />
        )}
        {current.slug === 'moderation' && <ModerationPanel account={account} />}
        {current.slug === 'users' && <UsersPanel account={account} />}
        {current.slug === 'organizations' && <OrganizationsPanel />}
        {current.slug === 'audit' && <AuditPanel />}
        {current.slug === 'scrapers' && <ScrapersPanel />}
        {current.slug === 'system' && <SystemPanel />}
      </div>

      <nav className="console__tabs" aria-label="Admin areas">
        {GROUPS.map((g) => {
          const first = visible.find((s) => s.group === g.id)
          if (!first) return null
          return (
            <Link key={g.id} href={href(first)} className="console__tab"
                  aria-current={g.id === current.group ? 'page' : undefined}>
              <Icon name={g.icon} />
              {g.tab}
              {g.id === 'content' && waiting > 0 && (
                <span className="console__count">{waiting}<span className="visually-hidden"> waiting</span></span>
              )}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}

/** The sidebar's icons: stroke-only, sized by the text beside them. */
function Icon({ name }: { name: IconName | 'back' | 'list' }) {
  const paths: Record<typeof name, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
    review: <><path d="M9 11l3 3 8-8" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /></>,
    people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></>,
    org: <><path d="M3 21V8l9-5 9 5v13" /><path d="M9 21v-6h6v6" /></>,
    audit: <path d="M4 6h16M4 12h16M4 18h10" />,
    scrape: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>,
    broom: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />,
    back: <path d="M15 18l-6-6 6-6" />,
    list: <><path d="M4 4h16v16H4z" /><path d="M8 9h8M8 13h8M8 17h5" /></>,
  }
  return (
    <svg className="console__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  )
}
