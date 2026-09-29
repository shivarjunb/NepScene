import { Badge, Button } from '../components/primitives'
import { Link } from '../router'
import type { AuditEntry, Page, Role } from '../lib/admin'

/** What the console's screens share: a date, a role badge, a pager, an audit row. */

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kathmandu',
})
const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Asia/Kathmandu' })

export const when = (iso: string | null, withTime = true) =>
  iso ? (withTime ? DATE_TIME : DATE).format(new Date(iso)) : '—'

const ROLE_TONE: Record<Role, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  visitor: 'neutral', organizer: 'accent', editor: 'success', admin: 'warning',
}

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={ROLE_TONE[role]}>{role}</Badge>
}

/**
 * Offset paging with no page count: the API sends one row of lookahead rather
 * than a COUNT(*), and "next" is all a person scanning a list needs. The
 * position is announced for the screen reader that cannot see the list move.
 */
export function Pager({ page, count, onPage }: {
  page: Page; count: number; onPage: (offset: number) => void
}) {
  if (page.offset === 0 && !page.has_more) return null
  const first = page.offset + 1
  const last = page.offset + count
  return (
    <nav className="admin__pager" aria-label="More rows">
      <span role="status">{count === 0 ? 'Nothing on this page' : `Rows ${first}–${last}`}</span>
      <Button type="button" size="sm" variant="ghost" disabled={page.offset === 0}
              onClick={() => onPage(Math.max(0, page.offset - page.limit))}>
        Previous
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={!page.has_more}
              onClick={() => onPage(page.offset + page.limit)}>
        Next
      </Button>
    </nav>
  )
}

/** Where an audited thing lives on the site, when it has a public page. */
function entityHref(entry: AuditEntry): string | null {
  if (!entry.entity_slug) return null
  switch (entry.entity_type) {
    case 'listing': return `/listings/${entry.entity_slug}`
    case 'venue': return `/venues/${entry.entity_slug}`
    case 'organization': return `/organizers/${entry.entity_slug}`
    default: return null
  }
}

/** A detail value as a person would write it: a list with commas, an object as JSON. */
const plain = (value: unknown): string =>
  Array.isArray(value) ? value.map(plain).join(', ')
    : value !== null && typeof value === 'object' ? JSON.stringify(value)
      : String(value)

/**
 * One line per event, in the order a person reads it: who, did what, to
 * which. The details are the API's JSON as it is — an audit row that has been
 * summarised is an audit row that has been edited.
 */
export function AuditRow({ entry }: { entry: AuditEntry }) {
  const href = entityHref(entry)
  const label = entry.entity_label ?? entry.entity_id
  const details = entry.details && Object.keys(entry.details).length > 0
    ? Object.entries(entry.details).map(([key, value]) => `${key}: ${plain(value)}`).join(' · ')
    : null

  return (
    <div className="admin__audit-row">
      <time className="admin__audit-when" dateTime={entry.created_at}>{when(entry.created_at)}</time>
      <div className="admin__audit-body">
        <p className="admin__audit-line">
          <strong>{entry.actor?.email ?? 'System'}</strong>
          {' '}
          <span className="admin__audit-action">{entry.action.replace(/_/g, ' ')}</span>
          {' '}
          <Badge>{entry.entity_type}</Badge>
          {' '}
          {href ? <Link href={href}>{label}</Link> : <span>{label}</span>}
        </p>
        {details && <p className="admin__audit-details">{details}</p>}
      </div>
    </div>
  )
}
