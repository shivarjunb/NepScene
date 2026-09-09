import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { fixtures, seedCatalogue } from '../helpers/seed'
import { kathmanduDay } from '../../api/catalog/events'

/**
 * #34 — the organizer dashboard and the counting behind it.
 *
 * The load-bearing test here is the scoping one: "an organizer sees only their
 * own listings" is a security boundary, not a filter, and the criterion says
 * to confirm it by direct API call rather than by looking at a screen.
 */

let ipCounter = 0
const nextIp = () => `192.0.2.${(ipCounter++ % 250) + 1}`

async function signIn(email: string, role: 'organizer' | 'editor' | 'admin' = 'organizer') {
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

const dashboard = (cookie: string, params = '') =>
  SELF.fetch(`https://nepscene.test/api/author/dashboard${params}`, { headers: { cookie } })

const beacon = (slug: string, kind: string) =>
  SELF.fetch(`https://nepscene.test/api/catalog/listings/${slug}/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind }),
  })

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM listing_stats'),
    env.DB.prepare('DELETE FROM organization_users'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

/** Hands every seeded listing to one author. */
const own = (userId: string, ids: string[]) =>
  env.DB.prepare(
    `UPDATE listings SET created_by = ?1 WHERE id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')})`,
  ).bind(userId, ...ids).run()

describe('whose listings an organizer can see', () => {
  it('shows the ones they created and nothing else', async () => {
    const mine = await signIn('mine@example.np')
    const theirs = await signIn('theirs@example.np')
    await own(mine.id, ['lst_soon', 'lst_draft'])
    await own(theirs.id, ['lst_later', 'lst_free'])

    const body = await (await dashboard(mine.cookie)).json() as any
    expect(body.data.map((row: any) => row.id).sort()).toEqual(['lst_draft', 'lst_soon'])
  })

  it('cannot be widened by asking the API directly', async () => {
    const mine = await signIn('direct@example.np')
    const theirs = await signIn('other@example.np')
    await own(theirs.id, ['lst_soon', 'lst_later', 'lst_free', 'lst_draft', 'lst_pending'])

    // Every parameter the endpoint takes, pointed at somebody else's work.
    for (const params of ['', '?status=published', '?q=Rock', '?limit=50&offset=0']) {
      const body = await (await dashboard(mine.cookie, params)).json() as any
      expect(body.data).toEqual([])
    }
  })

  it('includes an organization’s listings for its members', async () => {
    const { cookie, id } = await signIn('colleague@example.np')
    // Membership, not authorship: a listing written by someone who has since
    // left must stay visible to the organization it belongs to.
    await env.DB.prepare(
      `INSERT INTO organization_users (organization_id, user_id, org_role, created_at)
       VALUES ('org_a', ?1, 'member', ?2)`,
    ).bind(id, new Date().toISOString()).run()

    const body = await (await dashboard(cookie)).json() as any
    // The seed's org_a listings, none of which this user created.
    expect(body.data.map((row: any) => row.id).sort())
      .toEqual(['lst_draft', 'lst_later', 'lst_past', 'lst_running', 'lst_soon'])
  })

  it('gives an editor no wider a view of their own dashboard', async () => {
    // The screen for looking at everyone's work is the moderation queue, which
    // says what it is. This one is "your listings" whoever is asking.
    const { cookie } = await signIn('editor@example.np', 'editor')
    const body = await (await dashboard(cookie)).json() as any
    expect(body.data).toEqual([])
  })

  it('requires a session', async () => {
    const response = await SELF.fetch('https://nepscene.test/api/author/dashboard')
    expect(response.status).toBe(401)
  })
})

describe('filtering and searching', () => {
  it('filters by state, and the other tabs keep their counts', async () => {
    const { cookie, id } = await signIn('filter@example.np')
    await own(id, ['lst_soon', 'lst_draft', 'lst_pending'])

    const body = await (await dashboard(cookie, '?status=draft')).json() as any
    expect(body.data.map((row: any) => row.id)).toEqual(['lst_draft'])
    // Counts are for everything they own, not for the tab they are on.
    expect(body.counts).toMatchObject({ draft: 1, published: 1, pending_review: 1 })
  })

  it('searches titles, and does not trip over a LIKE wildcard', async () => {
    const { cookie, id } = await signIn('search@example.np')
    await own(id, ['lst_soon', 'lst_later'])

    const found = await (await dashboard(cookie, '?q=Rock')).json() as any
    expect(found.data.map((row: any) => row.title)).toEqual(['Rock Night'])

    // A percent sign is a character somebody typed, not a wildcard that
    // matches their whole catalogue.
    const wild = await (await dashboard(cookie, '?q=%25')).json() as any
    expect(wild.data).toEqual([])
  })

  it('refuses a status that is not one', async () => {
    const { cookie } = await signIn('bad-status@example.np')
    expect((await dashboard(cookie, '?status=deleted')).status).toBe(400)
  })

  it('pages, and says whether there is more', async () => {
    const { cookie, id } = await signIn('pager@example.np')
    await own(id, ['lst_soon', 'lst_later', 'lst_free'])

    const first = await (await dashboard(cookie, '?limit=2')).json() as any
    expect(first.data).toHaveLength(2)
    expect(first.page.has_more).toBe(true)

    const second = await (await dashboard(cookie, '?limit=2&offset=2')).json() as any
    expect(second.data).toHaveLength(1)
    expect(second.page.has_more).toBe(false)
  })

  it('answers in one round trip', async () => {
    // The criterion is a dashboard that loads in under a second at 100
    // listings, and a per-row stats query would make that impossible from
    // Kathmandu whatever the SQL did.
    const { cookie, id } = await signIn('trips@example.np')
    await own(id, ['lst_soon', 'lst_later', 'lst_free'])

    const response = await dashboard(cookie)
    expect(response.headers.get('x-d1-round-trips')).toBe('1')
  })
})

describe('counting views and clicks', () => {
  it('counts a view against the listing and the day', async () => {
    const { cookie, id } = await signIn('counted@example.np')
    await own(id, ['lst_soon'])

    await beacon('rock-night', 'view')
    await beacon('rock-night', 'view')
    await beacon('rock-night', 'click')

    const body = await (await dashboard(cookie)).json() as any
    const row = body.data.find((entry: any) => entry.id === 'lst_soon')
    expect(row).toMatchObject({ views: 2, clicks: 1 })

    // One row per listing per day, not one per view.
    const rows = await env.DB.prepare(
      `SELECT day, views, clicks FROM listing_stats WHERE listing_id = 'lst_soon'`,
    ).all<{ day: string; views: number; clicks: number }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]!.day).toBe(kathmanduDay())
  })

  it('counts nothing for a listing that is not published', async () => {
    // A draft has no public page, so a beacon naming one is a stale tab or
    // somebody poking at the endpoint. Either way it is not a view.
    await beacon('secret-draft', 'view')
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM listing_stats`)
      .first<{ n: number }>()
    expect(rows!.n).toBe(0)
  })

  it('counts nothing for a slug that does not exist, without failing', async () => {
    const response = await beacon('no-such-listing', 'view')
    expect(response.status).toBe(202)
  })

  it('refuses a kind it does not know', async () => {
    const response = await beacon('rock-night', 'purchase')
    expect(response.status).toBe(400)
    expect((await response.json() as any).error.code).toBe('invalid_kind')
  })

  it('needs no account, because a visitor has none', async () => {
    expect((await beacon('rock-night', 'view')).status).toBe(202)
  })
})

describe('duplicating a listing', () => {
  it('copies the parts that carry over and none of the parts that must not', async () => {
    const { cookie, id } = await signIn('copier@example.np')
    await own(id, ['lst_soon'])

    const response = await SELF.fetch(
      'https://nepscene.test/api/author/listings/lst_soon/duplicate',
      { method: 'POST', headers: { cookie } },
    )
    expect(response.status).toBe(201)
    const created = await response.json() as any

    const copy = await env.DB.prepare('SELECT * FROM listings WHERE id = ?1')
      .bind(created.id).first<Record<string, unknown>>()

    expect(copy!.title).toBe('Rock Night (copy)')
    expect(copy!.venue_id).toBe('ven_thamel')
    expect(copy!.summary).toBe('Rock Night summary')

    // A draft, never reviewed: duplicating must not be a way around the state
    // machine.
    expect(copy!.status).toBe('draft')
    expect(copy!.published_at).toBeNull()
    // The date is cleared, so the copy cannot be submitted with last year's.
    expect(copy!.starts_at).toBeNull()
    // A distinct slug, so the original's URL still resolves to the original.
    expect(copy!.slug).not.toBe('rock-night')

    // Taxonomy comes across; media does not, because the R2 objects belong to
    // the original and a shared object breaks whichever is deleted second.
    const categories = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM listing_categories WHERE listing_id = ?1',
    ).bind(created.id).first<{ n: number }>()
    expect(categories!.n).toBe(2)

    const media = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM listing_media WHERE listing_id = ?1',
    ).bind(created.id).first<{ n: number }>()
    expect(media!.n).toBe(0)
  })

  it('refuses somebody else’s listing', async () => {
    const theirs = await signIn('owner@example.np')
    const { cookie } = await signIn('thief@example.np')
    await own(theirs.id, ['lst_soon'])

    const response = await SELF.fetch(
      'https://nepscene.test/api/author/listings/lst_soon/duplicate',
      { method: 'POST', headers: { cookie } },
    )
    expect(response.status).toBe(403)
  })

  it('records who made the copy and what it came from', async () => {
    const { cookie, id } = await signIn('audited@example.np')
    await own(id, ['lst_soon'])
    await SELF.fetch('https://nepscene.test/api/author/listings/lst_soon/duplicate',
      { method: 'POST', headers: { cookie } })

    const entry = await env.DB.prepare(
      `SELECT details FROM audit_log WHERE action = 'duplicated'`,
    ).first<{ details: string }>()
    expect(JSON.parse(entry!.details).from).toBe('lst_soon')
  })
})

describe('what the dashboard says about each listing', () => {
  it('carries the rejection reason, so the author knows what to fix', async () => {
    const { cookie, id } = await signIn('rejected@example.np')
    await own(id, ['lst_pending'])
    await env.DB.prepare(
      `UPDATE listings SET status = 'rejected', rejection_reason = ?1 WHERE id = 'lst_pending'`,
    ).bind('The date is next month.').run()

    const body = await (await dashboard(cookie)).json() as any
    expect(body.data[0].rejection_reason).toBe('The date is next month.')
  })

  it('says where and when, so a list of twenty is readable', async () => {
    const { cookie, id } = await signIn('detail@example.np')
    await own(id, ['lst_soon'])

    const body = await (await dashboard(cookie)).json() as any
    expect(body.data[0]).toMatchObject({
      venue_name: 'Purple Haze', starts_at: fixtures.soon, media_count: 0,
    })
  })
})
