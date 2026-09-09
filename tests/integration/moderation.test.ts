import {
  createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext,
} from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { fixtures, seedCatalogue } from '../helpers/seed'
import { archiveFinishedListings } from '../../api/author/archive'
import worker from '../../api/index'

/**
 * #33 — the moderation queue, merging, bulk actions and auto-archive, against
 * a real Worker and a real D1.
 *
 * The scoring these lean on is unit-tested in tests/unit/listingMatch.test.ts.
 * What is settled here is everything that only a database can settle: that the
 * queue is ordered by how long an author has waited, that a merge loses no
 * data, that a bulk action still checks every row, and that the sweep does not
 * undo a decision a person made.
 */

let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`

async function signIn(email: string, role: 'organizer' | 'editor' | 'admin') {
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

const api = (path: string, cookie: string, body?: unknown) =>
  SELF.fetch(`https://nepscene.test/api/author${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? { cookie } : { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const statusOf = async (id: string) =>
  (await env.DB.prepare('SELECT status FROM listings WHERE id = ?1').bind(id)
    .first<{ status: string }>())?.status

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM organization_users'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

describe('the queue', () => {
  it('shows what is waiting, with everything a decision needs on the row', async () => {
    const { cookie } = await signIn('editor@example.np', 'editor')
    const response = await api('/queue', cookie)
    expect(response.status).toBe(200)

    const body = await response.json() as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      id: 'lst_pending', title: 'Awaiting Review', status: 'pending_review',
      venue_name: 'Lakeside',
    })
    // No second request per row: the categories and the media count are here.
    expect(body.data[0].category_slugs).toEqual(['community'])
    expect(body.data[0].media_count).toBe(0)
    // And the tab counts, so switching tabs is a filter rather than a reload.
    expect(body.counts.published).toBeGreaterThan(0)
    expect(body.counts.pending_review).toBe(1)
  })

  it('orders by how long the author has waited, not by when the event is', async () => {
    const { cookie } = await signIn('editor-order@example.np', 'editor')

    // Two submissions: the one waiting longest is for the event furthest away.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE listings SET status = 'pending_review', updated_at = ?1, starts_at = ?2
          WHERE id = 'lst_draft'`,
      ).bind('2020-01-01T00:00:00.000Z', fixtures.muchLater),
      env.DB.prepare(
        `UPDATE listings SET updated_at = ?1, starts_at = ?2 WHERE id = 'lst_pending'`,
      ).bind('2026-01-01T00:00:00.000Z', fixtures.soon),
    ])

    const body = await (await api('/queue', cookie)).json() as any
    // The feed's index would have put lst_pending first — its event is sooner.
    // A queue that did that starves whoever submitted something far off.
    expect(body.data.map((row: any) => row.id)).toEqual(['lst_draft', 'lst_pending'])
  })

  it('carries the duplicate flag a submission was given', async () => {
    const { cookie: organizer } = await signIn('org@example.np', 'organizer')
    const { cookie: editor } = await signIn('editor-dupe@example.np', 'editor')

    // A second copy of a published listing: same title, same venue, same night.
    await env.DB.prepare(
      `INSERT INTO listings (id, slug, title, listing_type, source, status,
                             venue_id, starts_at, created_by, created_at, updated_at)
       SELECT 'lst_copy', 'rock-night-again', 'Rock Night', 'free', 'submission', 'draft',
              'ven_thamel', ?1, u.id, ?2, ?2
         FROM users u WHERE u.email = 'org@example.np'`,
    ).bind(fixtures.soon, new Date().toISOString()).run()
    await env.DB.prepare(
      `INSERT INTO listing_categories (listing_id, category_id, is_primary)
       VALUES ('lst_copy', 'cat_concert', 1)`,
    ).run()

    const submitted = await api('/listings/lst_copy/submit', organizer, {})
    expect(submitted.status).toBe(200)

    // The author is told at once rather than days later through a rejection.
    const submitBody = await submitted.json() as any
    expect(submitBody.duplicate?.id).toBe('lst_soon')
    expect(submitBody.duplicate.message).toContain('Rock Night')

    const queue = await (await api('/queue', editor)).json() as any
    const flagged = queue.data.find((row: any) => row.id === 'lst_copy')
    expect(flagged.duplicate).toMatchObject({ id: 'lst_soon', title: 'Rock Night' })
    expect(flagged.duplicate.score).toBeGreaterThanOrEqual(0.75)
  })

  it('is closed to anyone who cannot moderate', async () => {
    const { cookie } = await signIn('nosy@example.np', 'organizer')
    expect((await api('/queue', cookie)).status).toBe(403)
  })
})

describe('bulk actions', () => {
  it('applies one decision to many listings', async () => {
    const { cookie } = await signIn('editor-bulk@example.np', 'editor')
    await env.DB.prepare(
      `UPDATE listings SET status = 'pending_review' WHERE id = 'lst_draft'`,
    ).run()

    const response = await api('/queue/actions', cookie, {
      action: 'publish', ids: ['lst_pending', 'lst_draft'],
    })
    expect(response.status).toBe(200)

    const body = await response.json() as any
    expect(body.applied.sort()).toEqual(['lst_draft', 'lst_pending'])
    expect(await statusOf('lst_pending')).toBe('published')
    expect(await statusOf('lst_draft')).toBe('published')
  })

  it('checks every row rather than trusting the batch', async () => {
    const { cookie } = await signIn('editor-mixed@example.np', 'editor')

    // One legal, one already published, one that does not exist. The legal one
    // must still go through: an editor who picked forty and got one wrong
    // should not have to work out which and start again.
    const body = await (await api('/queue/actions', cookie, {
      action: 'publish', ids: ['lst_pending', 'lst_soon', 'lst_nonexistent'],
    })).json() as any

    expect(body.applied).toEqual(['lst_pending'])
    expect(body.refused.map((row: any) => row.id).sort())
      .toEqual(['lst_nonexistent', 'lst_soon'])
    expect(await statusOf('lst_soon')).toBe('published')
  })

  it('will not reject in bulk without a reason either', async () => {
    const { cookie } = await signIn('editor-quiet@example.np', 'editor')
    const response = await api('/queue/actions', cookie, {
      action: 'reject', ids: ['lst_pending'],
    })

    expect(response.status).toBe(400)
    expect((await response.json() as any).error.code).toBe('reason_required')
    expect(await statusOf('lst_pending')).toBe('pending_review')
  })

  it('records the reason on every listing it rejects', async () => {
    const { cookie } = await signIn('editor-reason@example.np', 'editor')
    await env.DB.prepare(
      `UPDATE listings SET status = 'pending_review' WHERE id = 'lst_draft'`,
    ).run()

    await api('/queue/actions', cookie, {
      action: 'reject', ids: ['lst_pending', 'lst_draft'],
      reason: 'These are duplicates of listings already published.',
    })

    const rows = await env.DB.prepare(
      `SELECT id, rejection_reason FROM listings WHERE id IN ('lst_pending', 'lst_draft')`,
    ).all<{ id: string; rejection_reason: string | null }>()
    for (const row of rows.results) {
      expect(row.rejection_reason).toContain('duplicates')
    }
  })

  it('refuses a batch bigger than the bound', async () => {
    const { cookie } = await signIn('editor-flood@example.np', 'editor')
    const response = await api('/queue/actions', cookie, {
      action: 'publish', ids: Array.from({ length: 51 }, (_, i) => `lst_${i}`),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as any).error.code).toBe('too_many')
  })

  it('refuses a verb the state machine does not have', async () => {
    const { cookie } = await signIn('editor-verb@example.np', 'editor')
    // A bulk action that could reach a state the single action cannot would be
    // a hole in the state machine with a friendly name on it.
    for (const action of ['delete', 'unpublish', 'submit']) {
      const response = await api('/queue/actions', cookie, { action, ids: ['lst_pending'] })
      expect(response.status).toBe(400)
    }
  })
})

describe('merging', () => {
  beforeEach(async () => {
    const now = new Date().toISOString()
    // A thin duplicate: it has a description and a picture the survivor lacks,
    // and nothing else the survivor does not already have.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO listings (id, slug, title, description, listing_type, source,
                               status, venue_id, venue_room, starts_at, created_at, updated_at)
         VALUES ('lst_copy', 'rock-night-copy', 'Rock Night', 'The long description nobody else wrote',
                 'free', 'submission', 'pending_review', 'ven_thamel', 'Basement', ?1, ?2, ?2)`,
      ).bind(fixtures.soon, now),
      env.DB.prepare(
        `INSERT INTO listing_media (id, listing_id, r2_key, mime_type, alt_text, sort_order, created_at)
         VALUES ('med_copy', 'lst_copy', 'media/copy.jpg', 'image/jpeg', 'The poster', 0, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO listing_categories (listing_id, category_id, is_primary)
         VALUES ('lst_copy', 'cat_arts', 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO tags (slug, label, created_at) VALUES ('poster-art', 'Poster Art', ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO listing_tags (listing_id, tag_slug) VALUES ('lst_copy', 'poster-art')`,
      ),
    ])
  })

  it('loses nothing: the survivor gains what only the duplicate had', async () => {
    const { cookie } = await signIn('editor-merge@example.np', 'editor')

    const response = await api('/listings/lst_copy/merge', cookie, { into: 'lst_soon' })
    expect(response.status).toBe(200)
    expect((await response.json() as any).inherited).toContain('description')

    const winner = await env.DB.prepare(
      `SELECT description, venue_room FROM listings WHERE id = 'lst_soon'`,
    ).first<{ description: string | null; venue_room: string | null }>()
    expect(winner!.description).toBe('The long description nobody else wrote')
    expect(winner!.venue_room).toBe('Basement')

    // Sets are unioned, not replaced.
    const categories = await env.DB.prepare(
      `SELECT category_id FROM listing_categories WHERE listing_id = 'lst_soon'`,
    ).all<{ category_id: string }>()
    expect(categories.results.map((r) => r.category_id).sort())
      .toEqual(['cat_arts', 'cat_concert', 'cat_nightlife'])

    const tags = await env.DB.prepare(
      `SELECT tag_slug FROM listing_tags WHERE listing_id = 'lst_soon'`,
    ).all<{ tag_slug: string }>()
    expect(tags.results.map((r) => r.tag_slug).sort()).toEqual(['live-music', 'poster-art'])
  })

  it('moves media rather than copying it, so no R2 object has two owners', async () => {
    const { cookie } = await signIn('editor-media@example.np', 'editor')
    await api('/listings/lst_copy/merge', cookie, { into: 'lst_soon' })

    const media = await env.DB.prepare(
      `SELECT listing_id FROM listing_media WHERE id = 'med_copy'`,
    ).first<{ listing_id: string }>()
    expect(media!.listing_id).toBe('lst_soon')
    // Copying would leave two listings pointing at one object, and deleting
    // either would break the other's picture (#25).
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM listing_media WHERE r2_key = 'media/copy.jpg'`,
    ).first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('never overwrites a field the survivor already answered', async () => {
    const { cookie } = await signIn('editor-keep@example.np', 'editor')
    await env.DB.prepare(
      `UPDATE listings SET description = 'The survivor’s own words' WHERE id = 'lst_soon'`,
    ).run()

    await api('/listings/lst_copy/merge', cookie, { into: 'lst_soon' })

    const winner = await env.DB.prepare(
      `SELECT description FROM listings WHERE id = 'lst_soon'`,
    ).first<{ description: string }>()
    expect(winner!.description).toBe('The survivor’s own words')
  })

  it('archives the loser pointing at the survivor rather than deleting it', async () => {
    const { cookie } = await signIn('editor-point@example.np', 'editor')
    await api('/listings/lst_copy/merge', cookie, { into: 'lst_soon' })

    const loser = await env.DB.prepare(
      `SELECT status, duplicate_of, slug FROM listings WHERE id = 'lst_copy'`,
    ).first<{ status: string; duplicate_of: string; slug: string }>()
    // The slug has to stay redirectable (#24) and its author deserves to be
    // shown where their submission went.
    expect(loser).toMatchObject({ status: 'archived', duplicate_of: 'lst_soon' })
  })

  it('records both sides in the audit log', async () => {
    const { cookie } = await signIn('editor-audit@example.np', 'editor')
    await api('/listings/lst_copy/merge', cookie, { into: 'lst_soon' })

    const entries = await env.DB.prepare(
      `SELECT entity_id, action FROM audit_log WHERE action IN ('merged', 'merged_in')`,
    ).all<{ entity_id: string; action: string }>()
    expect(entries.results).toHaveLength(2)
  })

  it('refuses a merge into itself, or into something already archived', async () => {
    const { cookie } = await signIn('editor-refuse@example.np', 'editor')

    expect((await api('/listings/lst_copy/merge', cookie, { into: 'lst_copy' })).status).toBe(400)

    await env.DB.prepare(`UPDATE listings SET status = 'archived' WHERE id = 'lst_soon'`).run()
    const response = await api('/listings/lst_copy/merge', cookie, { into: 'lst_soon' })
    expect(response.status).toBe(400)
    expect((await response.json() as any).error.code).toBe('archived_target')
  })

  it('is closed to anyone who cannot moderate', async () => {
    const { cookie } = await signIn('org-merge@example.np', 'organizer')
    expect((await api('/listings/lst_copy/merge', cookie, { into: 'lst_soon' })).status).toBe(403)
  })
})

describe('auto-archive', () => {
  it('archives a listing that finished, once the grace period is past', async () => {
    // lst_past finished ten days ago; lst_soon has not happened yet.
    const result = await archiveFinishedListings(env)

    expect(result.archived).toContain('lst_past')
    expect(result.archived).not.toContain('lst_soon')
    expect(await statusOf('lst_past')).toBe('archived')
    expect(await statusOf('lst_soon')).toBe('published')
  })

  it('leaves an event that is still running alone', async () => {
    // lst_running started yesterday and ends tomorrow. Its end has not passed.
    await archiveFinishedListings(env)
    expect(await statusOf('lst_running')).toBe('published')
  })

  it('gives a day of grace after the end', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    await env.DB.prepare(
      `UPDATE listings SET starts_at = ?1, ends_at = ?1 WHERE id = 'lst_later'`,
    ).bind(twoHoursAgo).run()

    // Over, but people are still looking it up. Taking the page away now is
    // taking it from exactly the people most likely to want it.
    await archiveFinishedListings(env)
    expect(await statusOf('lst_later')).toBe('published')
  })

  it('touches nothing that is not published', async () => {
    await env.DB.prepare(
      `UPDATE listings SET status = 'draft' WHERE id = 'lst_past'`,
    ).run()

    const result = await archiveFinishedListings(env)
    expect(result.archived).not.toContain('lst_past')
    expect(await statusOf('lst_past')).toBe('draft')
  })

  it('records the sweep with no actor, because there was none', async () => {
    await archiveFinishedListings(env)

    const entry = await env.DB.prepare(
      `SELECT actor_id, actor_role, details FROM audit_log
        WHERE action = 'auto_archived' AND entity_id = 'lst_past'`,
    ).first<{ actor_id: string | null; actor_role: string | null; details: string }>()

    // Attributing it to an administrator would make the log lie about who
    // archived somebody's listing, which is the question the row answers.
    expect(entry!.actor_id).toBeNull()
    expect(entry!.actor_role).toBeNull()
    expect(JSON.parse(entry!.details).grace_hours).toBe(24)
  })

  it('is a no-op when there is nothing to archive', async () => {
    await archiveFinishedListings(env)
    const second = await archiveFinishedListings(env)
    expect(second).toEqual({ archived: [], scanned: 0 })
  })

  it('is what the cron trigger actually reaches', async () => {
    // The handler, not the function under it. Exporting the Hono app directly
    // — which is what `export default app` did before #33 — would leave
    // wrangler.jsonc's trigger firing into a Worker with nothing to receive
    // it, and a cron nobody is waiting on fails silently.
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '15 18 * * *' }), env, ctx)
    await waitOnExecutionContext(ctx)

    expect(await statusOf('lst_past')).toBe('archived')
  })
})
