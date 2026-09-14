import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

/**
 * #28 — the admin console's API, against a real Worker and a real D1.
 *
 * What is settled here: that only `user:manage` opens any of it, that every
 * change an administrator makes is in the audit log with their name on it,
 * that the two ways of locking yourself out are refused, and that each list
 * screen is one round trip.
 */

let ipCounter = 0
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`

async function signIn(email: string, role: 'visitor' | 'organizer' | 'editor' | 'admin') {
  const response = await SELF.fetch('https://nepscene.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email, password: 'a-decent-passphrase' }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  await env.DB.prepare('UPDATE users SET role = ?1 WHERE email = ?2').bind(role, email).run()
  const { id } = (await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email)
    .first<{ id: string }>())!
  return { cookie, id }
}

const api = (method: string, path: string, cookie: string, body?: unknown) =>
  SELF.fetch(`https://nepscene.test/api/admin${path}`, {
    method,
    headers: body === undefined ? { cookie } : { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const get = (path: string, cookie: string) => api('GET', path, cookie)

const auditRows = async (action: string) =>
  (await env.DB.prepare('SELECT * FROM audit_log WHERE action = ?1').bind(action).all<any>()).results

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM organization_users'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

describe('who may open it', () => {
  it('is admins only — an editor can moderate but cannot administer', async () => {
    const { cookie: editor } = await signIn('editor@example.np', 'editor')
    const { cookie: organizer } = await signIn('org@example.np', 'organizer')

    for (const path of ['/overview', '/users', '/organizations', '/audit']) {
      expect((await get(path, editor)).status, path).toBe(403)
      expect((await get(path, organizer)).status, path).toBe(403)
      expect((await get(path, '')).status, path).toBe(401)
    }
    expect((await api('POST', '/system/archive', editor)).status).toBe(403)
  })
})

describe('the overview', () => {
  it('counts everyone and everything in one round trip', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    await signIn('ed@example.np', 'editor')
    await signIn('v@example.np', 'visitor')

    const response = await get('/overview', cookie)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-d1-round-trips')).toBe('1')

    const body = await response.json() as any
    expect(body.users.admin).toEqual({ total: 1, inactive: 0 })
    expect(body.users.editor.total).toBe(1)
    expect(body.users.visitor.total).toBe(1)
    expect(body.users.organizer).toEqual({ total: 0, inactive: 0 })
    expect(body.listings.published).toBeGreaterThan(0)
    expect(body.listings.pending_review).toBe(1)
    expect(body.organizations).toEqual({ total: 1, verified: 1 })
    expect(Array.isArray(body.recent)).toBe(true)
  })
})

describe('users', () => {
  it('lists accounts with how they sign in and what they have written', async () => {
    const { cookie, id } = await signIn('admin@example.np', 'admin')
    await signIn('writer@example.np', 'organizer')
    await env.DB.prepare(
      `UPDATE listings SET created_by = (SELECT id FROM users WHERE email = 'writer@example.np')
        WHERE id IN ('lst_soon', 'lst_draft')`,
    ).run()

    const response = await get('/users', cookie)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-d1-round-trips')).toBe('1')

    const body = await response.json() as any
    const writer = body.data.find((row: any) => row.email === 'writer@example.np')
    expect(writer).toMatchObject({
      role: 'organizer', is_active: true, has_password: true, has_google: false,
      listing_count: 2, organization_count: 0,
    })
    expect(body.data.find((row: any) => row.id === id).role).toBe('admin')
    expect(body.counts).toEqual({ visitor: 0, organizer: 1, editor: 0, admin: 1 })
    expect(body.page).toEqual({ limit: 25, offset: 0, has_more: false })
  })

  it('searches by email or name and filters by role', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    await signIn('binaya@example.np', 'visitor')
    await signIn('other@example.np', 'editor')
    await env.DB.prepare("UPDATE users SET name = 'Binaya R' WHERE email = 'other@example.np'").run()

    const byEmail = await (await get('/users?q=binaya@', cookie)).json() as any
    expect(byEmail.data.map((row: any) => row.email)).toEqual(['binaya@example.np'])

    const byName = await (await get('/users?q=Binaya%20R', cookie)).json() as any
    expect(byName.data.map((row: any) => row.email)).toEqual(['other@example.np'])

    const byRole = await (await get('/users?role=editor', cookie)).json() as any
    expect(byRole.data.map((row: any) => row.email)).toEqual(['other@example.np'])
    // Counts ignore the filter: they say how many of each role exist.
    expect(byRole.counts.visitor).toBe(1)

    expect((await get('/users?role=overlord', cookie)).status).toBe(400)
  })

  it('pages with one row of lookahead rather than a count', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    for (let i = 0; i < 3; i++) await signIn(`u${i}@example.np`, 'visitor')

    const first = await (await get('/users?limit=2', cookie)).json() as any
    expect(first.data).toHaveLength(2)
    expect(first.page.has_more).toBe(true)

    const last = await (await get('/users?limit=2&offset=2', cookie)).json() as any
    expect(last.data).toHaveLength(2)
    expect(last.page.has_more).toBe(false)
  })

  it('changes a role, records who did it, and answers with the row', async () => {
    const { cookie, id: adminId } = await signIn('admin@example.np', 'admin')
    const { id } = await signIn('promoted@example.np', 'visitor')

    const response = await api('PATCH', `/users/${id}`, cookie, { role: 'editor' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id, role: 'editor', is_active: true })

    const [row] = await auditRows('role_changed')
    expect(row.actor_id).toBe(adminId)
    expect(row.actor_role).toBe('admin')
    expect(JSON.parse(row.details)).toEqual({ from: 'visitor', to: 'editor' })
  })

  it('deactivating ends every session; reactivating does not bring them back', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    const subject = await signIn('gone@example.np', 'organizer')

    const me = () => SELF.fetch('https://nepscene.test/api/auth/me', { headers: { cookie: subject.cookie } })
    expect((await me()).status).toBe(200)

    const off = await api('PATCH', `/users/${subject.id}`, cookie, { is_active: false })
    expect(off.status).toBe(200)
    expect((await off.json() as any).is_active).toBe(false)
    expect((await me()).status).toBe(401)
    expect(await auditRows('deactivated')).toHaveLength(1)

    // A deactivated account cannot sign in either.
    const login = await SELF.fetch('https://nepscene.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
      body: JSON.stringify({ email: 'gone@example.np', password: 'a-decent-passphrase' }),
    })
    expect(login.status).not.toBe(200)

    await api('PATCH', `/users/${subject.id}`, cookie, { is_active: true })
    expect((await me()).status).toBe(401)
    expect(await auditRows('reactivated')).toHaveLength(1)
  })

  it('refuses the two ways of locking yourself out, and nonsense', async () => {
    const { cookie, id } = await signIn('admin@example.np', 'admin')

    expect((await api('PATCH', `/users/${id}`, cookie, { role: 'visitor' })).status).toBe(400)
    expect((await api('PATCH', `/users/${id}`, cookie, { is_active: false })).status).toBe(400)
    // Same role, same state: a no-op, not an error.
    expect((await api('PATCH', `/users/${id}`, cookie, { role: 'admin', is_active: true })).status).toBe(200)

    expect((await api('PATCH', `/users/${id}`, cookie, {})).status).toBe(400)
    expect((await api('PATCH', `/users/${id}`, cookie, { role: 'overlord' })).status).toBe(400)
    expect((await api('PATCH', `/users/${id}`, cookie, { is_active: 'no' })).status).toBe(400)
    expect((await api('PATCH', '/users/nobody', cookie, { role: 'editor' })).status).toBe(404)
    // Nothing above wrote anything.
    expect(await auditRows('role_changed')).toHaveLength(0)
  })
})

describe('organizations', () => {
  it('lists with members and listings counted, and opens one with its members', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    const { id: memberId } = await signIn('member@example.np', 'organizer')
    await env.DB.prepare(
      `INSERT INTO organization_users (organization_id, user_id, org_role, created_at)
       VALUES ('org_a', ?1, 'owner', ?2)`,
    ).bind(memberId, new Date().toISOString()).run()

    const list = await get('/organizations', cookie)
    expect(list.headers.get('x-d1-round-trips')).toBe('1')
    const body = await list.json() as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      id: 'org_a', slug: 'himalayan-sound', name: 'Himalayan Sound', is_verified: true,
      member_count: 1,
    })
    expect(body.data[0].listing_count).toBeGreaterThan(0)
    expect(body.data[0].published_count).toBeLessThanOrEqual(body.data[0].listing_count)

    const one = await get('/organizations/org_a', cookie)
    expect(one.headers.get('x-d1-round-trips')).toBe('1')
    const detail = await one.json() as any
    expect(detail.members).toEqual([expect.objectContaining({
      user_id: memberId, email: 'member@example.np', org_role: 'owner', role: 'organizer',
    })])

    expect((await get('/organizations/nope', cookie)).status).toBe(404)
    expect((await (await get('/organizations?q=zzz', cookie)).json() as any).data).toEqual([])
  })

  it('adds a member by email, promoting a visitor to organizer on the way', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    const { id, cookie: subjectCookie } = await signIn('new@example.np', 'visitor')

    const added = await api('PUT', '/organizations/org_a/members', cookie,
      { email: 'New@Example.np', org_role: 'manager' })
    expect(added.status).toBe(200)
    expect((await added.json() as any).members).toEqual([expect.objectContaining({
      user_id: id, org_role: 'manager', role: 'organizer',
    })])

    // Effective at once: the wizard's lookups now offer the organization.
    const lookups = await (await SELF.fetch('https://nepscene.test/api/author/lookups',
      { headers: { cookie: subjectCookie } })).json() as any
    expect(lookups.organizations).toEqual([expect.objectContaining({ id: 'org_a', org_role: 'manager' })])

    // The same call again changes the org_role rather than failing on the key.
    const changed = await api('PUT', '/organizations/org_a/members', cookie,
      { email: 'new@example.np', org_role: 'member' })
    expect((await changed.json() as any).members[0].org_role).toBe('member')

    const [row] = await auditRows('member_set')
    expect(JSON.parse(row.details)).toMatchObject({ user_id: id, org_role: 'manager', promoted: true })
  })

  it('refuses an unknown email, an unknown organization and a made-up org_role', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    expect((await api('PUT', '/organizations/org_a/members', cookie, { email: 'nobody@example.np' })).status).toBe(404)
    expect((await api('PUT', '/organizations/nope/members', cookie, { email: 'admin@example.np' })).status).toBe(404)
    expect((await api('PUT', '/organizations/org_a/members', cookie, { email: 'admin@example.np', org_role: 'boss' })).status).toBe(400)
    expect((await api('PUT', '/organizations/org_a/members', cookie, { email: '' })).status).toBe(400)
  })

  it('removes a member without touching their role', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    const { id } = await signIn('leaving@example.np', 'organizer')
    await api('PUT', '/organizations/org_a/members', cookie, { email: 'leaving@example.np' })

    const removed = await api('DELETE', `/organizations/org_a/members/${id}`, cookie)
    expect(removed.status).toBe(200)
    expect((await removed.json() as any).members).toEqual([])
    expect(await auditRows('member_removed')).toHaveLength(1)

    const role = await env.DB.prepare('SELECT role FROM users WHERE id = ?1').bind(id).first<any>()
    expect(role.role).toBe('organizer')

    // Removing again is a 404, and records nothing.
    expect((await api('DELETE', `/organizations/org_a/members/${id}`, cookie)).status).toBe(404)
    expect(await auditRows('member_removed')).toHaveLength(1)
  })

  it('verifies and unverifies, and the public catalogue sees it', async () => {
    const { cookie } = await signIn('admin@example.np', 'admin')
    const before = await (await SELF.fetch('https://nepscene.test/api/catalog/organizers/himalayan-sound')).json() as any
    expect(before.organizer.is_verified).toBe(true)

    const response = await api('PATCH', '/organizations/org_a', cookie, { is_verified: false })
    expect(response.status).toBe(200)
    expect(await auditRows('unverified')).toHaveLength(1)

    const after = await (await SELF.fetch('https://nepscene.test/api/catalog/organizers/himalayan-sound')).json() as any
    expect(after.organizer.is_verified).toBe(false)

    // Same value again is a no-op, not a second audit row.
    await api('PATCH', '/organizations/org_a', cookie, { is_verified: false })
    expect(await auditRows('unverified')).toHaveLength(1)

    expect((await api('PATCH', '/organizations/org_a', cookie, { is_verified: 'yes' })).status).toBe(400)
    expect((await api('PATCH', '/organizations/nope', cookie, { is_verified: true })).status).toBe(404)
  })
})

describe('the audit trail', () => {
  it('reads newest first with every row resolved to a name', async () => {
    const { cookie, id: adminId } = await signIn('admin@example.np', 'admin')
    const { id } = await signIn('subject@example.np', 'visitor')

    await api('PATCH', `/users/${id}`, cookie, { role: 'organizer' })
    await api('PATCH', '/organizations/org_a', cookie, { is_verified: false })

    const response = await get('/audit', cookie)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-d1-round-trips')).toBe('1')

    const body = await response.json() as any
    expect(body.data.map((row: any) => row.action)).toEqual(['unverified', 'role_changed'])
    expect(body.data[0]).toMatchObject({
      entity_type: 'organization', entity_label: 'Himalayan Sound', entity_slug: 'himalayan-sound',
      actor: { id: adminId, email: 'admin@example.np', role: 'admin' },
    })
    expect(body.data[1]).toMatchObject({
      entity_type: 'user', entity_id: id, entity_label: 'subject@example.np',
      details: { from: 'visitor', to: 'organizer' },
    })
  })

  it('filters by what and by whom', async () => {
    const { cookie, id: adminId } = await signIn('admin@example.np', 'admin')
    const { id } = await signIn('subject@example.np', 'visitor')
    await api('PATCH', `/users/${id}`, cookie, { role: 'organizer' })
    await api('PATCH', '/organizations/org_a', cookie, { is_verified: false })

    const users = await (await get('/audit?entity_type=user', cookie)).json() as any
    expect(users.data.map((row: any) => row.action)).toEqual(['role_changed'])

    const org = await (await get('/audit?entity_type=organization&entity_id=org_a', cookie)).json() as any
    expect(org.data.map((row: any) => row.action)).toEqual(['unverified'])

    const byActor = await (await get(`/audit?actor_id=${adminId}`, cookie)).json() as any
    expect(byActor.data).toHaveLength(2)

    expect((await get('/audit?entity_type=invoice', cookie)).status).toBe(400)
  })
})

describe('housekeeping', () => {
  it('runs the archive sweep on demand and says what it did', async () => {
    const { cookie, id } = await signIn('admin@example.np', 'admin')

    const response = await api('POST', '/system/archive', cookie)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    // The seed has one published listing well in the past.
    expect(body.archived).toBe(1)

    const status = await env.DB.prepare("SELECT status FROM listings WHERE id = 'lst_past'").first<any>()
    expect(status.status).toBe('archived')

    const [row] = await auditRows('archived_on_demand')
    expect(row.actor_id).toBe(id)

    // Nothing left to archive: no second audit row.
    expect((await (await api('POST', '/system/archive', cookie)).json() as any).archived).toBe(0)
    expect(await auditRows('archived_on_demand')).toHaveLength(1)
  })
})
