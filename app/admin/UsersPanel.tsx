import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '../components/primitives'
import { AuthorError, type Account } from '../lib/author'
import { fetchUsers, ROLES, updateUser, type AdminUser, type Role, type UserList } from '../lib/admin'
import { Pager, RoleBadge, when } from './shared'

/**
 * Accounts (#28): who can do what, and the switch that turns one off.
 *
 * **The role is a select on the row, not a form behind it.** The whole job of
 * this screen is "make this person an editor", and a screen that needs a
 * click, a dialog and a save for that is a screen an admin goes around with
 * SQL. The select applies on change, the row shows the result, and the audit
 * log has the rest.
 *
 * **Deactivation asks.** It ends every session the person has and it is the
 * one thing here that someone will notice at once, so it is the one action
 * that wants a second click.
 */
export function UsersPanel({ account }: { account: Account }) {
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<Role | ''>('')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<UserList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (q: string, which: Role | '', from: number) => {
    setLoading(true)
    setError(null)
    try {
      setList(await fetchUsers({ q, role: which || undefined, offset: from }))
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'The accounts did not load')
    } finally {
      setLoading(false)
    }
  }, [])

  // Debounced, so typing an address is one request rather than one per letter.
  useEffect(() => {
    const timer = setTimeout(() => void load(query.trim(), role, offset), query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [query, role, offset, load])

  const change = async (user: AdminUser, patch: { role?: Role; is_active?: boolean }) => {
    setBusyId(user.id)
    setNote(null)
    setError(null)
    try {
      const updated = await updateUser(user.id, patch)
      // The row is replaced in place: a reload would lose the page and the
      // search, and the API answered with the row precisely so it need not.
      setList((current) => current && {
        ...current,
        data: current.data.map((row) => (row.id === updated.id ? updated : row)),
        counts: patch.role && patch.role !== user.role
          ? { ...current.counts, [user.role]: current.counts[user.role] - 1, [patch.role]: current.counts[patch.role] + 1 }
          : current.counts,
      })
      setNote(patch.role
        ? `${updated.email} is now ${patch.role === 'visitor' ? 'a' : 'an'} ${patch.role}.`
        : updated.is_active
          ? `${updated.email} can sign in again.`
          : `${updated.email} is deactivated and signed out everywhere.`)
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'That did not work')
    } finally {
      setBusyId(null)
    }
  }

  const rows = list?.data ?? []
  const total = Object.values(list?.counts ?? {}).reduce((sum, n) => sum + n, 0)

  return (
    <section className="admin__section" aria-labelledby="admin-heading">

      {note && <Alert tone="success" title="Done">{note}</Alert>}
      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <div className="board__controls">
        <nav className="board__tabs" aria-label="Accounts by role">
          <button type="button" className={`queue__tab${role === '' ? ' is-current' : ''}`}
                  aria-current={role === '' ? 'true' : undefined}
                  onClick={() => { setRole(''); setOffset(0) }}>
            Everyone <span className="queue__count">{total}</span>
          </button>
          {ROLES.map((which) => (
            <button key={which} type="button"
                    className={`queue__tab${role === which ? ' is-current' : ''}`}
                    aria-current={role === which ? 'true' : undefined}
                    onClick={() => { setRole(which); setOffset(0) }}>
              {which} <span className="queue__count">{list?.counts[which] ?? 0}</span>
            </button>
          ))}
        </nav>

        <Field label="Find an account">
          {({ id }) => (
            <Input id={id} type="search" placeholder="Email or name…" value={query}
                   onChange={(event) => { setQuery(event.target.value); setOffset(0) }} />
          )}
        </Field>
      </div>

      {loading && <div className="wizard__loading"><Spinner label="Loading accounts" /></div>}

      {!loading && rows.length === 0 && (
        <Card><p className="queue__empty">No account matches.</p></Card>
      )}

      {rows.length > 0 && (
        <ul className="admin__list">
          {rows.map((user) => (
            <li key={user.id}>
              <UserRow user={user} self={user.id === account.id} busy={busyId === user.id}
                       onRole={(next) => void change(user, { role: next })}
                       onActive={(active) => void change(user, { is_active: active })} />
            </li>
          ))}
        </ul>
      )}

      {list && <Pager page={list.page} count={rows.length} onPage={setOffset} />}
    </section>
  )
}

function UserRow({ user, self, busy, onRole, onActive }: {
  user: AdminUser
  self: boolean
  busy: boolean
  onRole: (role: Role) => void
  onActive: (active: boolean) => void
}) {
  const signsInWith = [user.has_password && 'password', user.has_google && 'Google']
    .filter(Boolean).join(' and ') || 'nothing yet'

  return (
    <Card className={`admin__row${user.is_active ? '' : ' admin__row--off'}`}>
      <div className="admin__row-body">
        <h2 className="admin__row-title">
          {user.email}
          {self && <Badge tone="accent">you</Badge>}
          {!user.is_active && <Badge tone="danger">deactivated</Badge>}
        </h2>
        <p className="board__meta">
          <RoleBadge role={user.role} />
          {user.name && <>{user.name} · </>}
          signs in with {signsInWith}
          {!user.email_verified && <> · <Badge tone="warning">unverified</Badge></>}
        </p>
        <p className="board__meta">
          {user.listing_count} {user.listing_count === 1 ? 'listing' : 'listings'}
          {' · '}
          {user.organization_count} {user.organization_count === 1 ? 'organization' : 'organizations'}
          {' · '}
          joined {when(user.created_at, false)}
          {' · '}
          last seen {when(user.last_login_at)}
        </p>
      </div>

      <div className="admin__row-actions">
        {/* Own role and own switch are read-only on purpose: the API refuses
            both, and a control that always fails is worse than none. */}
        <Field label="Role">
          {({ id }) => (
            <Select id={id} value={user.role} disabled={self || busy}
                    onChange={(event) => onRole(event.target.value as Role)}>
              {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
            </Select>
          )}
        </Field>
        {user.is_active ? (
          <Button type="button" size="sm" variant="secondary" disabled={self} loading={busy}
                  onClick={() => {
                    if (window.confirm(`Deactivate ${user.email}? They are signed out everywhere and cannot sign in until reactivated.`)) {
                      onActive(false)
                    }
                  }}>
            Deactivate
          </Button>
        ) : (
          <Button type="button" size="sm" loading={busy} onClick={() => onActive(true)}>
            Reactivate
          </Button>
        )}
      </div>
    </Card>
  )
}
