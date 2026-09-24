import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '../components/primitives'
import { AuthorError } from '../lib/author'
import {
  fetchOrganization, fetchOrganizations, ORG_ROLES, removeMember, setMember, setVerified,
  type AdminOrganization, type Member, type OrganizationDetail, type OrganizationList, type OrgRole,
} from '../lib/admin'
import { Link } from '../router'
import { Pager, RoleBadge, when } from './shared'

/**
 * Organizations (#28): who may author for each, and whether it is verified.
 *
 * The list is the index and one organization opens in place below it — not a
 * second page, because the normal shape of the work is "find it, add the
 * person, check the tick, next". Members are added by email, which is what
 * the request that prompted this always contains.
 */
export function OrganizationsPanel() {
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<OrganizationList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async (q: string, from: number) => {
    setLoading(true)
    setError(null)
    try {
      setList(await fetchOrganizations({ q, offset: from }))
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'The organizations did not load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void load(query.trim(), offset), query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [query, offset, load])

  /** A change inside the open organization is reflected on its list row. */
  const patchRow = (id: string, patch: Partial<AdminOrganization>) =>
    setList((current) => current && {
      ...current, data: current.data.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    })

  const rows = list?.data ?? []

  return (
    <section className="admin__section" aria-labelledby="admin-heading">

      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <div className="board__controls">
        <Field label="Find an organization">
          {({ id }) => (
            <Input id={id} type="search" placeholder="Name…" value={query}
                   onChange={(event) => { setQuery(event.target.value); setOffset(0) }} />
          )}
        </Field>
      </div>

      {loading && <div className="wizard__loading"><Spinner label="Loading organizations" /></div>}

      {!loading && rows.length === 0 && (
        <Card><p className="queue__empty">No organization matches.</p></Card>
      )}

      {rows.length > 0 && (
        <ul className="admin__list">
          {rows.map((org) => (
            <li key={org.id}>
              <Card className="admin__row">
                <div className="admin__row-body">
                  <h2 className="admin__row-title">
                    <Link href={`/organizers/${org.slug}`}>{org.name}</Link>
                    {org.is_verified && <Badge tone="success">verified</Badge>}
                  </h2>
                  <p className="board__meta">
                    {org.member_count} {org.member_count === 1 ? 'member' : 'members'}
                    {' · '}
                    {org.published_count} published of {org.listing_count}
                    {org.contact_email && <> · {org.contact_email}</>}
                  </p>
                </div>
                <div className="admin__row-actions">
                  <Button type="button" size="sm" variant={openId === org.id ? 'secondary' : 'ghost'}
                          aria-expanded={openId === org.id}
                          onClick={() => setOpenId(openId === org.id ? null : org.id)}>
                    {openId === org.id ? 'Close' : 'Members…'}
                  </Button>
                </div>
              </Card>
              {openId === org.id && (
                <OrganizationDetailCard id={org.id}
                                        onChanged={(patch) => patchRow(org.id, patch)} />
              )}
            </li>
          ))}
        </ul>
      )}

      {list && <Pager page={list.page} count={rows.length} onPage={setOffset} />}
    </section>
  )
}

function OrganizationDetailCard({ id, onChanged }: {
  id: string
  onChanged: (patch: Partial<AdminOrganization>) => void
}) {
  const [detail, setDetail] = useState<OrganizationDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const [orgRole, setOrgRole] = useState<OrgRole>('member')

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    fetchOrganization(id).then(
      (found) => { if (!cancelled) setDetail(found) },
      (caught: unknown) => {
        if (!cancelled) setError(caught instanceof AuthorError ? caught.message : 'That did not load')
      },
    )
    return () => { cancelled = true }
  }, [id])

  const withMembers = (members: Member[]) => {
    setDetail((current) => current && { ...current, members })
    onChanged({ member_count: members.length })
  }

  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  const add = () => run(async () => {
    const { members } = await setMember(id, email.trim(), orgRole)
    withMembers(members)
    setEmail('')
  }, 'Could not add them')

  const remove = (member: Member) => run(async () => {
    const { members } = await removeMember(id, member.user_id)
    withMembers(members)
  }, 'Could not remove them')

  const verify = (verified: boolean) => run(async () => {
    await setVerified(id, verified)
    setDetail((current) => current && { ...current, is_verified: verified })
    onChanged({ is_verified: verified })
  }, 'Could not change that')

  if (!detail) {
    return error
      ? <Alert tone="danger" title="Something went wrong">{error}</Alert>
      : <div className="wizard__loading"><Spinner label="Loading members" /></div>
  }

  return (
    <Card raised className="admin__detail">
      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <div className="admin__detail-head">
        <p className="board__meta">
          <code>{detail.slug}</code>
          {detail.website_url && <> · <a href={detail.website_url} rel="noreferrer">{detail.website_url}</a></>}
          {' · '}since {when(detail.created_at, false)}
        </p>
        <Button type="button" size="sm" variant={detail.is_verified ? 'ghost' : 'primary'}
                loading={busy} onClick={() => verify(!detail.is_verified)}>
          {detail.is_verified ? 'Remove verification' : 'Mark as verified'}
        </Button>
      </div>

      <h3 className="admin__detail-title">Members</h3>
      {detail.members.length === 0 && (
        <p className="board__meta">Nobody yet. Whoever is added first should be the owner.</p>
      )}
      {detail.members.length > 0 && (
        <ul className="admin__members">
          {detail.members.map((member) => (
            <li key={member.user_id} className="admin__member">
              <span className="admin__member-who">
                <strong>{member.email}</strong>
                {member.name && <> · {member.name}</>}
                {!member.is_active && <> <Badge tone="danger">deactivated</Badge></>}
              </span>
              <span className="admin__member-roles">
                <Badge tone="accent">{member.org_role}</Badge>
                <RoleBadge role={member.role} />
              </span>
              <Button type="button" size="sm" variant="ghost" loading={busy}
                      onClick={() => void remove(member)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form className="admin__add-member"
            onSubmit={(event) => { event.preventDefault(); void add() }}>
        <Field label="Add a member by email"
               hint="A visitor added here becomes an organizer at the same time.">
          {({ id: fieldId, describedBy }) => (
            <Input id={fieldId} type="email" required value={email} aria-describedby={describedBy}
                   placeholder="someone@example.com"
                   onChange={(event) => setEmail(event.target.value)} />
          )}
        </Field>
        <Field label="As">
          {({ id: fieldId }) => (
            <Select id={fieldId} value={orgRole}
                    onChange={(event) => setOrgRole(event.target.value as OrgRole)}>
              {ORG_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
            </Select>
          )}
        </Field>
        <Button type="submit" size="sm" loading={busy} disabled={!email.trim()}>Add</Button>
      </form>
    </Card>
  )
}
