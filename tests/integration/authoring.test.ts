import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`

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

const api = (path: string, cookie: string, init: RequestInit = {}) =>
  SELF.fetch(`https://nepscene.test/api/author${path}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

const create = (cookie: string, body: Record<string, unknown>) =>
  api('/listings', cookie, { method: 'POST', body: JSON.stringify(body) })

const patch = (cookie: string, id: string, body: Record<string, unknown>) =>
  api(`/listings/${id}`, cookie, { method: 'PATCH', body: JSON.stringify(body) })

const roundTrips = (response: Response) => Number(response.headers.get('x-d1-round-trips'))

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM organization_users'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

describe('lookups', () => {
  it('answers every list the wizard needs in one request and one round trip', async () => {
    const { cookie } = await signIn('lookups@example.np')
    const response = await api('/lookups', cookie)
    expect(response.status).toBe(200)

    const body = await response.json() as Record<string, unknown[]>
    // The WaahTickets defect this endpoint exists to avoid: four independent
    // lists fetched in two stages. All five arrive together or this fails.
    for (const key of ['categories', 'venues', 'artists', 'organizations', 'tags']) {
      expect(Array.isArray(body[key]), `${key} missing`).toBe(true)
    }
    expect(body.categories!.length).toBeGreaterThan(0)
    expect(body.venues!.length).toBeGreaterThan(0)

    // The assertion that makes "no waterfall" a constraint rather than a hope.
    expect(roundTrips(response)).toBe(1)
  })

  it('offers only the organizations the author actually belongs to', async () => {
    const { cookie, id } = await signIn('member@example.np')
    const before = await (await api('/lookups', cookie)).json() as { organizations: unknown[] }
    expect(before.organizations).toEqual([])

    await env.DB.prepare(
      `INSERT INTO organization_users (organization_id, user_id, org_role, created_at)
       VALUES ('org_a', ?1, 'manager', ?2)`,
    ).bind(id, new Date().toISOString()).run()

    const after = await (await api('/lookups', cookie)).json() as
      { organizations: { id: string; org_role: string }[] }
    expect(after.organizations).toEqual([expect.objectContaining({ id: 'org_a', org_role: 'manager' })])
  })

  it('turns a visitor away', async () => {
    const { cookie } = await signIn('nobody@example.np')
    await env.DB.prepare("UPDATE users SET role = 'visitor' WHERE email = 'nobody@example.np'").run()
    expect((await api('/lookups', cookie)).status).toBe(403)
  })
})

describe('creating a listing of each type', () => {
  const base = {
    starts_at: '2027-03-01T12:00:00Z',
    category_slugs: ['concerts'],
    primary_category_slug: 'concerts',
    venue_id: 'ven_thamel',
  }

  const cases = [
    { listing_type: 'free', title: 'Lake Clean-up Two' },
    { listing_type: 'ticketed_internal', title: 'Kutumba Live' },
    { listing_type: 'ticketed_external', title: 'Jazzmandu', offer_url: 'https://tickets.example/e/9' },
    { listing_type: 'announcement', title: 'Road Closure Notice', venue_id: null },
  ]

  for (const body of cases) {
    it(`creates, submits and publishes a ${body.listing_type} listing`, async () => {
      const { cookie } = await signIn(`${body.listing_type}@example.np`, 'editor')

      const created = await create(cookie, { ...base, ...body })
      expect(created.status).toBe(201)
      const { id, slug, status } = await created.json() as
        { id: string; slug: string; status: string }
      expect(status).toBe('draft')
      expect(slug).toBeTruthy()

      // Nothing unpublished reaches the public feed.
      const draftPage = await SELF.fetch(`https://nepscene.test/api/catalog/listings/${slug}`)
      expect(draftPage.status).toBe(404)

      const submitted = await api(`/listings/${id}/submit`, cookie, { method: 'POST' })
      expect(submitted.status).toBe(200)

      const published = await api(`/listings/${id}/publish`, cookie, { method: 'POST' })
      expect(published.status).toBe(200)

      const row = await env.DB.prepare(
        'SELECT listing_type, source, status, offer_provider FROM listings WHERE id = ?1',
      ).bind(id).first<Record<string, unknown>>()
      expect(row?.listing_type).toBe(body.listing_type)
      expect(row?.status).toBe('published')
      // Provenance: everything written through the wizard is an organizer's work.
      expect(row?.source).toBe('organizer')
    })
  }

  it('derives the offer provider from the type rather than trusting the author', async () => {
    const { cookie } = await signIn('provider@example.np')
    const internal = await (await create(cookie, {
      ...base, listing_type: 'ticketed_internal', title: 'Internal',
    })).json() as { id: string }
    const external = await (await create(cookie, {
      ...base, listing_type: 'ticketed_external', title: 'External',
      offer_url: 'https://tickets.example/e/2',
    })).json() as { id: string }

    const providerOf = async (id: string) => (await env.DB.prepare(
      'SELECT offer_provider FROM listings WHERE id = ?1',
    ).bind(id).first<{ offer_provider: string | null }>())?.offer_provider

    expect(await providerOf(internal.id)).toBe('waahtickets')
    expect(await providerOf(external.id)).toBe('external')

    // Switched to free, the provider has to go with it.
    await patch(cookie, external.id, { listing_type: 'free', offer_url: null })
    expect(await providerOf(external.id)).toBe(null)
  })

  it('gives exactly one primary category even when the author names none', async () => {
    const { cookie } = await signIn('primary@example.np')
    const { id } = await (await create(cookie, {
      ...base, title: 'Two Categories', category_slugs: ['concerts', 'nightlife'],
      primary_category_slug: null,
    })).json() as { id: string }

    const { results } = await env.DB.prepare(
      'SELECT is_primary FROM listing_categories WHERE listing_id = ?1',
    ).bind(id).all<{ is_primary: number }>()
    expect(results.length).toBe(2)
    expect(results.filter((r) => r.is_primary === 1).length).toBe(1)
  })

  it('rejects a category that is not in the closed set, and says which', async () => {
    const { cookie } = await signIn('badcat@example.np')
    const response = await create(cookie, { ...base, title: 'Bad', category_slugs: ['gambling'] })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('unknown_category')
    expect(body.error.message).toContain('gambling')
  })
})

describe('a draft saves in whatever state it is in', () => {
  it('accepts a listing with almost nothing filled in', async () => {
    const { cookie } = await signIn('half@example.np')
    // This is the normal state of a draft two seconds after it is started, and
    // refusing it would defeat the point of autosave.
    const response = await create(cookie, { title: 'Untitled thou' })
    expect(response.status).toBe(201)
  })

  it('does not invent a start date for a draft that has none', async () => {
    const { cookie } = await signIn('nodate@example.np')
    const { id } = await (await create(cookie, { title: 'No date yet', listing_type: 'free' }))
      .json() as { id: string }

    // Stamping the creation time here (which NOT NULL used to force) is worse
    // than storing nothing: the draft reopens showing a real-looking date the
    // author never chose, and validation has nothing left to object to.
    const row = await env.DB.prepare('SELECT starts_at FROM listings WHERE id = ?1')
      .bind(id).first<{ starts_at: string | null }>()
    expect(row?.starts_at).toBe(null)

    const body = await (await api(`/listings/${id}`, cookie)).json() as
      { listing: { starts_at: string } }
    expect(body.listing.starts_at).toBe('')

    const refused = await api(`/listings/${id}/submit`, cookie, { method: 'POST' })
    const error = await refused.json() as { error: { fields: { field: string }[] } }
    expect(error.error.fields.map((f) => f.field)).toContain('starts_at')
  })

  it('keeps a dateless draft out of every public feed', async () => {
    const { cookie } = await signIn('hidden@example.np')
    const { slug } = await (await create(cookie, { title: 'Invisible', listing_type: 'free' }))
      .json() as { slug: string }

    // COALESCE(ends_at, starts_at) >= now is NULL for a dateless row, which is
    // not true, so it falls out of every feed without a query changing.
    const feed = await (await SELF.fetch('https://nepscene.test/api/catalog/listings'))
      .json() as { data: { slug: string }[] }
    expect(feed.data.map((l) => l.slug)).not.toContain(slug)
  })

  it('refuses to send that same listing for review, naming each field', async () => {
    const { cookie } = await signIn('incomplete@example.np')
    const { id } = await (await create(cookie, { title: 'Not ready', listing_type: 'free' }))
      .json() as { id: string }

    const response = await api(`/listings/${id}/submit`, cookie, { method: 'POST' })
    expect(response.status).toBe(400)

    const body = await response.json() as
      { error: { code: string; fields: { field: string; message: string }[] } }
    expect(body.error.code).toBe('incomplete_listing')
    const named = body.error.fields.map((f) => f.field)
    expect(named).toContain('venue_id')
    expect(named).toContain('category_slugs')
    // "Name the field and say how to fix it" — no bare "required" anywhere.
    for (const { message } of body.error.fields) {
      expect(message.length).toBeGreaterThan(12)
      expect(message).not.toMatch(/^required$/i)
    }

    expect(await env.DB.prepare('SELECT status FROM listings WHERE id = ?1').bind(id)
      .first<{ status: string }>()).toMatchObject({ status: 'draft' })
  })
})

describe('autosave', () => {
  const base = {
    title: 'Autosaved', listing_type: 'free', starts_at: '2027-04-01T12:00:00Z',
    category_slugs: ['concerts'], primary_category_slug: 'concerts', venue_id: 'ven_thamel',
  }

  it('recovers everything written before a simulated crash', async () => {
    const { cookie } = await signIn('crash@example.np')
    const { id } = await (await create(cookie, base)).json() as { id: string }

    // Three autosaves land, then the tab dies before the fourth.
    await patch(cookie, id, { summary: 'An evening of folk' })
    await patch(cookie, id, { description: 'Long description written slowly' })
    await patch(cookie, id, { tags: ['Live Music', 'live music', 'Outdoors'] })

    // A new tab loads the draft back — this is the recovery path.
    const reloaded = await api(`/listings/${id}`, cookie)
    expect(reloaded.status).toBe(200)
    const body = await reloaded.json() as
      { status: string; listing: Record<string, unknown> }

    expect(body.status).toBe('draft')
    expect(body.listing.summary).toBe('An evening of folk')
    expect(body.listing.description).toBe('Long description written slowly')
    expect(body.listing.title).toBe('Autosaved')
    // Tags normalise on the way in: two spellings of one tag are one tag.
    expect(body.listing.tags).toEqual(['Live Music', 'Outdoors'])
  })

  it('loads edit mode in a single round trip', async () => {
    const { cookie } = await signIn('editload@example.np')
    const { id } = await (await create(cookie, base)).json() as { id: string }

    const response = await api(`/listings/${id}`, cookie)
    // Listing, categories, tags, artists and media are five reads; sequentially
    // that is a second of latency from Kathmandu against a two-second budget.
    expect(roundTrips(response)).toBe(1)
  })

  it('leaves untouched fields alone', async () => {
    const { cookie } = await signIn('partial@example.np')
    const { id } = await (await create(cookie, { ...base, summary: 'Original summary' }))
      .json() as { id: string }

    // A step the author never opened must not blank what another step wrote.
    await patch(cookie, id, { description: 'Added later' })

    const body = await (await api(`/listings/${id}`, cookie)).json() as
      { listing: Record<string, unknown> }
    expect(body.listing.summary).toBe('Original summary')
    expect(body.listing.description).toBe('Added later')
  })

  it('clears a field when the author really does empty it', async () => {
    const { cookie } = await signIn('clear@example.np')
    const { id } = await (await create(cookie, { ...base, summary: 'Original summary' }))
      .json() as { id: string }

    await patch(cookie, id, { summary: null })

    const body = await (await api(`/listings/${id}`, cookie)).json() as
      { listing: Record<string, unknown> }
    expect(body.listing.summary).toBe(null)
  })
})

describe('slugs', () => {
  const base = {
    listing_type: 'free', starts_at: '2027-05-01T12:00:00Z',
    category_slugs: ['concerts'], primary_category_slug: 'concerts', venue_id: 'ven_thamel',
  }

  it('transliterates a Devanagari title rather than dropping it', async () => {
    const { cookie } = await signIn('devanagari@example.np')
    const { slug } = await (await create(cookie, { ...base, title: 'इन्द्रजात्रा' }))
      .json() as { slug: string }
    expect(slug).toMatch(/^[a-z0-9-]+$/)
    expect(slug).not.toMatch(/^untitled/)
  })

  it('re-mints a draft slug on retitle and leaves no redirect behind', async () => {
    const { cookie } = await signIn('retitle@example.np')
    const { id, slug } = await (await create(cookie, { ...base, title: 'First Title' }))
      .json() as { id: string; slug: string }
    expect(slug).toBe('first-title')

    const updated = await (await patch(cookie, id, { title: 'Second Title' }))
      .json() as { slug: string }
    expect(updated.slug).toBe('second-title')

    const redirects = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM slug_redirects WHERE entity_id = ?1",
    ).bind(id).first<{ n: number }>()
    // Nobody ever linked to a draft, so there is nothing to keep a promise to.
    expect(redirects?.n).toBe(0)
  })

  it('leaves a redirect when a published listing is retitled', async () => {
    const { cookie } = await signIn('published@example.np', 'editor')
    const { id } = await (await create(cookie, { ...base, title: 'Public Title' }))
      .json() as { id: string }
    await api(`/listings/${id}/submit`, cookie, { method: 'POST' })
    await api(`/listings/${id}/publish`, cookie, { method: 'POST' })

    await patch(cookie, id, { title: 'Renamed After Launch' })

    const redirect = await env.DB.prepare(
      "SELECT old_slug FROM slug_redirects WHERE entity_id = ?1",
    ).bind(id).first<{ old_slug: string }>()
    expect(redirect?.old_slug).toBe('public-title')
  })
})

describe('who may edit what', () => {
  const base = {
    title: 'Someone elses', listing_type: 'free', starts_at: '2027-06-01T12:00:00Z',
    category_slugs: ['concerts'], primary_category_slug: 'concerts', venue_id: 'ven_thamel',
  }

  it('refuses another organizer', async () => {
    const { cookie: owner } = await signIn('owner@example.np')
    const { id } = await (await create(owner, base)).json() as { id: string }

    const { cookie: stranger } = await signIn('stranger@example.np')
    expect((await api(`/listings/${id}`, stranger)).status).toBe(403)
    expect((await patch(stranger, id, { title: 'Hijacked' })).status).toBe(403)
  })

  it('allows a colleague in the same organization', async () => {
    const { cookie: owner } = await signIn('orgowner@example.np')
    const { id } = await (await create(owner, { ...base, organization_id: 'org_a' }))
      .json() as { id: string }

    const { cookie: colleague, id: colleagueId } = await signIn('colleague@example.np')
    await env.DB.prepare(
      `INSERT INTO organization_users (organization_id, user_id, org_role, created_at)
       VALUES ('org_a', ?1, 'member', ?2)`,
    ).bind(colleagueId, new Date().toISOString()).run()

    expect((await api(`/listings/${id}`, colleague)).status).toBe(200)
  })

  it('turns away someone with no session at all', async () => {
    expect((await api('/lookups', '')).status).toBe(401)
    expect((await create('', base)).status).toBe(401)
  })
})

describe('the author’s own listings', () => {
  it('lists their drafts newest first and nobody else’s', async () => {
    const { cookie } = await signIn('mine@example.np')
    const base = {
      listing_type: 'free', starts_at: '2027-07-01T12:00:00Z',
      category_slugs: ['concerts'], primary_category_slug: 'concerts', venue_id: 'ven_thamel',
    }
    await create(cookie, { ...base, title: 'Older draft' })
    await create(cookie, { ...base, title: 'Newer draft' })

    const { cookie: other } = await signIn('theirs@example.np')
    await create(other, { ...base, title: 'Not mine' })

    const body = await (await api('/listings', cookie)).json() as
      { data: { title: string }[] }
    const titles = body.data.map((row) => row.title)
    expect(titles).toContain('Older draft')
    expect(titles).toContain('Newer draft')
    expect(titles).not.toContain('Not mine')
  })
})

/**
 * The fields the wizard writes but the tests above never exercise, because the
 * happy path through the form does not touch them: the ones that go in as one
 * shape and come back as another.
 */
describe('the fields that change shape on the way in and out', () => {
  const base = {
    listing_type: 'free' as const, starts_at: '2027-07-01T12:00:00Z',
    category_slugs: ['concerts'], primary_category_slug: 'concerts', venue_id: 'ven_thamel',
  }

  const load = async (cookie: string, id: string) =>
    await (await api(`/listings/${id}`, cookie)).json() as
      { listing: Record<string, unknown>; media: Record<string, unknown>[] }

  it('keeps coordinates as numbers and ignores ones that are not', async () => {
    const { cookie } = await signIn('coords@example.np')
    const { id } = await (await create(cookie, {
      ...base, title: 'Pinned', location_lat: 27.7154, location_lng: 85.3105,
    })).json() as { id: string }

    expect((await load(cookie, id)).listing).toMatchObject({
      location_lat: 27.7154, location_lng: 85.3105,
    })

    // Explicit null is the author clearing the override, which is different
    // from not sending it, and must actually clear.
    await patch(cookie, id, { location_lat: null, location_lng: null })
    expect((await load(cookie, id)).listing).toMatchObject({
      location_lat: null, location_lng: null,
    })
  })

  it('treats a coordinate sent as text as a cleared one, not an ignored one', async () => {
    const { cookie } = await signIn('coordtext@example.np')
    const { id } = await (await create(cookie, {
      ...base, title: 'Pinned', location_lat: 27.7154, location_lng: 85.3105,
    })).json() as { id: string }

    // Surprising enough to pin down. The key being present at all is the
    // author's client saying something about this field, so an unreadable
    // value clears it rather than being skipped — the same rule the string
    // fields follow. The alternative, silently keeping the old pin, hides the
    // client bug behind a coordinate nobody chose; a pin that visibly
    // disappears gets reported.
    await patch(cookie, id, { location_lat: '27.7', location_lng: '85.3' })
    expect((await load(cookie, id)).listing).toMatchObject({
      location_lat: null, location_lng: null,
    })
  })

  it('stores an all-day flag as a flag and gives it back as a boolean', async () => {
    const { cookie } = await signIn('allday@example.np')
    const { id } = await (await create(cookie, { ...base, title: 'All day long' }))
      .json() as { id: string }

    expect((await load(cookie, id)).listing.is_all_day).toBe(false)

    await patch(cookie, id, { is_all_day: true })
    expect((await load(cookie, id)).listing.is_all_day).toBe(true)

    // SQLite has no boolean, so this round-trips through 1 and 0. A test that
    // only ever sets it true would not notice the column coming back as 1.
    const row = await env.DB.prepare('SELECT is_all_day FROM listings WHERE id = ?1')
      .bind(id).first<{ is_all_day: number }>()
    expect(row!.is_all_day).toBe(1)
  })

  it('round-trips the map popup configuration through JSON', async () => {
    const { cookie } = await signIn('popup@example.np')
    const { id } = await (await create(cookie, { ...base, title: 'Popup' }))
      .json() as { id: string }

    await patch(cookie, id, { map_popup_config: { layout: 'wide', show_price: false } })
    expect((await load(cookie, id)).listing.map_popup_config)
      .toEqual({ layout: 'wide', show_price: false })

    await patch(cookie, id, { map_popup_config: null })
    expect((await load(cookie, id)).listing.map_popup_config).toBeNull()
  })

  it('links the artists it is given and skips the ones it does not know', async () => {
    const { cookie } = await signIn('artists@example.np')
    const { id } = await (await create(cookie, {
      ...base, title: 'With a band', artist_slugs: ['kutumba', 'nobody-by-that-name'],
    })).json() as { id: string }

    // An unknown slug is a stale tab, not a typo worth losing a save over, so
    // it is dropped rather than rejected — and the real one still lands.
    expect((await load(cookie, id)).listing.artist_slugs).toEqual(['kutumba'])

    await patch(cookie, id, { artist_slugs: [] })
    expect((await load(cookie, id)).listing.artist_slugs).toEqual([])
  })

  it('returns uploaded pictures with a URL the browser can use', async () => {
    const { cookie, id: userId } = await signIn('media@example.np')
    const { id } = await (await create(cookie, { ...base, title: 'Illustrated' }))
      .json() as { id: string }

    await env.DB.prepare(
      `INSERT INTO listing_media
         (id, listing_id, r2_key, mime_type, alt_text, width, height, sort_order,
          created_by, created_at)
       VALUES ('med_a', ?1, 'media/med_a/original.jpg', 'image/jpeg',
               'The band on stage', 1600, 900, 0, ?2, ?3)`,
    ).bind(id, userId, new Date().toISOString()).run()

    const { media } = await load(cookie, id)
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({
      id: 'med_a', alt_text: 'The band on stage', width: 1600, height: 900,
    })
    // The r2 key is storage's business; what the wizard needs is a URL.
    expect(String(media[0]!.url)).not.toBe('media/med_a/original.jpg')
    expect(String(media[0]!.url)).toContain('med_a')
  })

  it('recomputes the offer provider from the stored type when only the link moves',
    async () => {
      const { cookie } = await signIn('provider@example.np')
      const { id } = await (await create(cookie, {
        ...base, title: 'Sold elsewhere', listing_type: 'ticketed_external',
        offer_url: 'https://tickets.example.np/a',
      })).json() as { id: string }

      const providerOf = async () =>
        (await env.DB.prepare('SELECT offer_provider FROM listings WHERE id = ?1')
          .bind(id).first<{ offer_provider: string | null }>())!.offer_provider

      expect(await providerOf()).not.toBeNull()

      // The type is not in this PATCH, so the provider has to be derived from
      // what is already stored. Reading the old type back is the step that
      // stops a listing keeping a provider that no longer means anything.
      await patch(cookie, id, { offer_url: null })
      expect(await providerOf()).toBeNull()
    })

  it('refuses a body that is not JSON, on the way in and on the way back', async () => {
    const { cookie } = await signIn('garbage@example.np')
    const { id } = await (await create(cookie, { ...base, title: 'Fine so far' }))
      .json() as { id: string }

    for (const [method, path] of [['POST', '/listings'], ['PATCH', `/listings/${id}`]] as const) {
      const response = await api(path, cookie, { method, body: 'not json at all' })
      expect(response.status, `${method} ${path}`).toBe(400)
      expect((await response.json() as { error: { code: string } }).error.code)
        .toBe('invalid_body')
    }
  })
})
