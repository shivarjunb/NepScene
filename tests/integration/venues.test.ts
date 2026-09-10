import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

/**
 * The venue picker, end to end (#31).
 *
 * The seed puts "Purple Haze" in Thamel at 27.7154, 85.3105 and "Lakeside" in
 * Pokhara, which is enough to exercise both duplicate signals and the city
 * rule that keeps them apart.
 */

let ipCounter = 0
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`

async function signIn(email: string, role: 'visitor' | 'organizer' | 'editor' = 'organizer') {
  const response = await SELF.fetch('https://nepscene.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email, password: 'a-decent-passphrase' }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  await env.DB.prepare('UPDATE users SET role = ?1 WHERE email = ?2').bind(role, email).run()
  return cookie
}

const api = (path: string, cookie: string, init: RequestInit = {}) =>
  SELF.fetch(`https://nepscene.test/api/author${path}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

const search = (cookie: string, q: string) =>
  api(`/venues?q=${encodeURIComponent(q)}`, cookie)

const createVenue = (cookie: string, body: Record<string, unknown>) =>
  api('/venues', cookie, { method: 'POST', body: JSON.stringify(body) })

const roundTrips = (response: Response) => Number(response.headers.get('x-d1-round-trips'))

type SearchBody = {
  query: string
  suggest_create: boolean
  data: { id: string; name: string; tier: number; slug: string }[]
}
type CreateBody = {
  id?: string
  slug?: string
  duplicates?: { id: string; name: string; reason: string; distance_m: number | null }[]
  error?: { code: string; message: string; fields: { field: string; message: string }[] }
  venue?: { id: string; name: string }
}

beforeEach(async () => {
  await seedCatalogue()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM organization_users'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ])
})

describe('GET /api/author/venues', () => {
  it('finds an existing venue and stops offering to create one, in one round trip', async () => {
    const cookie = await signIn('search@example.np')
    const response = await search(cookie, 'Purple Haze')
    expect(response.status).toBe(200)

    const body = await response.json() as SearchBody
    expect(body.data[0]?.name).toBe('Purple Haze')
    // The acceptance criterion: the venue that exists comes back above the
    // option to add another one.
    expect(body.suggest_create).toBe(false)
    // An autocomplete fires on every keystroke. Two round trips here is 400ms
    // per character from Kathmandu (docs/ARCHITECTURE.md).
    expect(roundTrips(response)).toBe(1)
  })

  it('still offers to create when nothing matches exactly', async () => {
    const cookie = await signIn('partial@example.np')
    const body = await (await search(cookie, 'Purple')).json() as SearchBody
    expect(body.data.map((v) => v.name)).toContain('Purple Haze')
    expect(body.suggest_create).toBe(true)
  })

  it('matches an area as well as a name, and ranks the name first', async () => {
    const cookie = await signIn('area@example.np')
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO venues (id, slug, name, area, city, created_at, updated_at)
       VALUES ('ven_thamelhouse', 'thamel-house', 'Thamel House', 'Chhetrapati', 'Kathmandu', ?1, ?1)`,
    ).bind(now).run()

    const body = await (await search(cookie, 'Thamel')).json() as SearchBody
    expect(body.data[0]?.name).toBe('Thamel House')
    // Purple Haze is in Thamel but is not called it.
    expect(body.data.map((v) => v.name)).toContain('Purple Haze')
  })

  it('finds nothing rather than everything for a one-letter query', async () => {
    const cookie = await signIn('short@example.np')
    const response = await search(cookie, 'P')
    expect(response.status).toBe(400)
    expect((await response.json() as CreateBody).error?.code).toBe('query_too_short')
  })

  it('turns away a visitor', async () => {
    const cookie = await signIn('nobody@example.np', 'visitor')
    expect((await search(cookie, 'Purple')).status).toBe(403)
  })
})

describe('POST /api/author/venues', () => {
  it('creates a venue in two round trips and finds it immediately afterwards', async () => {
    const cookie = await signIn('creator@example.np')
    const response = await createVenue(cookie, {
      name: 'Kutumba Studio', city: 'Lalitpur', area: 'Jhamsikhel',
      latitude: 27.6766, longitude: 85.3159,
    })
    expect(response.status).toBe(201)
    const created = await response.json() as CreateBody
    expect(created.slug).toBe('kutumba-studio')
    expect(created.duplicates).toEqual([])
    // One read (duplicates, place id and slug siblings together), one write.
    expect(roundTrips(response)).toBe(2)

    // The reason these endpoints read the primary rather than a replica: the
    // author who just made it has to be able to find it.
    const found = await (await search(cookie, 'Kutumba Studio')).json() as SearchBody
    expect(found.data[0]?.id).toBe(created.id)
    expect(found.suggest_create).toBe(false)
  })

  it('warns about a near duplicate by name rather than rejecting it', async () => {
    const cookie = await signIn('dupe-name@example.np')
    await createVenue(cookie, { name: 'Kutumba Studio', city: 'Lalitpur' })

    const response = await createVenue(cookie, { name: 'Kutumba Studio Jhamsikhel', city: 'Lalitpur' })
    expect(response.status).toBe(409)
    const body = await response.json() as CreateBody
    expect(body.error?.code).toBe('possible_duplicate')
    // A warning that names the venue it resembles, not a rule number.
    expect(body.error?.message).toContain('Kutumba Studio')
    expect(body.duplicates?.[0]?.reason).toBe('name')
    // Refusing costs one round trip; nothing was written.
    expect(roundTrips(response)).toBe(1)

    const { count } = (await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM venues WHERE name LIKE 'Kutumba%'`,
    ).first<{ count: number }>())!
    expect(count).toBe(1)
  })

  it('warns about a near duplicate by distance even under a different name', async () => {
    const cookie = await signIn('dupe-pin@example.np')
    // ~55m north of the seeded Purple Haze, which is 27.7154, 85.3105.
    const response = await createVenue(cookie, {
      name: 'Something Completely Different', city: 'Kathmandu',
      latitude: 27.7159, longitude: 85.3105,
    })
    expect(response.status).toBe(409)
    const body = await response.json() as CreateBody
    expect(body.duplicates?.[0]?.name).toBe('Purple Haze')
    expect(body.duplicates?.[0]?.reason).toBe('distance')
    expect(body.duplicates?.[0]?.distance_m).toBeLessThan(150)
  })

  it('lets a venue through once the author confirms it is a different place', async () => {
    const cookie = await signIn('confirm@example.np')
    const body = { name: 'Purple Haze Rock Bar', city: 'Kathmandu' }
    expect((await createVenue(cookie, body)).status).toBe(409)

    const response = await createVenue(cookie, { ...body, confirm_duplicate: true })
    expect(response.status).toBe(201)
    const created = await response.json() as CreateBody
    // The answer still carries what was overridden, so the wizard can say so.
    expect(created.duplicates?.[0]?.name).toBe('Purple Haze')

    // And the override is on the record, for whoever merges duplicates later.
    const audit = await env.DB.prepare(
      `SELECT details FROM audit_log WHERE entity_type = 'venue' AND entity_id = ?1`,
    ).bind(created.id).first<{ details: string }>()
    expect(JSON.parse(audit!.details).confirmed_over_duplicates).toHaveLength(1)
  })

  it('does not warn across cities, and gives the second one its own slug', async () => {
    const cookie = await signIn('cities@example.np')
    const response = await createVenue(cookie, { name: 'Lakeside', city: 'Kathmandu' })
    expect(response.status).toBe(201)
    // The seeded Lakeside is in Pokhara and keeps `lakeside`.
    expect((await response.json() as CreateBody).slug).toBe('lakeside-2')
  })

  it('refuses a venue Google has already identified, because that is not a resemblance', async () => {
    const cookie = await signIn('placeid@example.np')
    await env.DB.prepare(
      `UPDATE venues SET google_place_id = 'ChIJ-purple-haze' WHERE id = 'ven_thamel'`,
    ).run()

    const response = await createVenue(cookie, {
      name: 'A Totally Unrelated Name', city: 'Bhaktapur',
      google_place_id: 'ChIJ-purple-haze',
    })
    expect(response.status).toBe(409)
    const body = await response.json() as CreateBody
    expect(body.error?.code).toBe('venue_exists')
    expect(body.venue?.name).toBe('Purple Haze')
    // Confirming does not get past an identity, only past a resemblance.
    const forced = await createVenue(cookie, {
      name: 'A Totally Unrelated Name', city: 'Bhaktapur',
      google_place_id: 'ChIJ-purple-haze', confirm_duplicate: true,
    })
    expect(forced.status).toBe(409)
  })

  it('refuses coordinates entered the wrong way round', async () => {
    const cookie = await signIn('swapped@example.np')
    const response = await createVenue(cookie, {
      name: 'Swapped Pin', city: 'Kathmandu', latitude: 85.3105, longitude: 27.7154,
    })
    expect(response.status).toBe(400)
    const body = await response.json() as CreateBody
    expect(body.error?.code).toBe('invalid_venue')
    expect(body.error?.fields.map((f) => f.field)).toContain('latitude')
  })

  it('asks for a name before anything else', async () => {
    const cookie = await signIn('nameless@example.np')
    const response = await createVenue(cookie, { city: 'Kathmandu' })
    expect(response.status).toBe(400)
    expect((await response.json() as CreateBody).error?.fields[0]?.field).toBe('name')
  })
})

describe('a room inside a venue', () => {
  const listing = (cookie: string, body: Record<string, unknown>) =>
    api('/listings', cookie, { method: 'POST', body: JSON.stringify(body) })

  it('is stored on the listing and read back, without a venue of its own', async () => {
    const cookie = await signIn('room@example.np')
    const created = await (await listing(cookie, {
      title: 'Handicraft Fair', listing_type: 'free',
      venue_id: 'ven_thamel', venue_room: 'Hall B',
    })).json() as { id: string }

    const loaded = await (await api(`/listings/${created.id}`, cookie)).json() as
      { listing: { venue_id: string; venue_room: string | null } }
    expect(loaded.listing.venue_id).toBe('ven_thamel')
    expect(loaded.listing.venue_room).toBe('Hall B')

    // The point of the column: one venue, two listings, two rooms.
    const second = await (await listing(cookie, {
      title: 'Book Fair', listing_type: 'free',
      venue_id: 'ven_thamel', venue_room: 'Hall A',
    })).json() as { id: string }
    const { count } = (await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM venues WHERE id = ?1',
    ).bind('ven_thamel').first<{ count: number }>())!
    expect(count).toBe(1)
    expect(second.id).not.toBe(created.id)
  })

  it('is cleared by sending null and left alone by a patch that omits it', async () => {
    const cookie = await signIn('room-patch@example.np')
    const created = await (await listing(cookie, {
      title: 'Craft Market', listing_type: 'free',
      venue_id: 'ven_thamel', venue_room: 'Stall 14',
    })).json() as { id: string }

    await api(`/listings/${created.id}`, cookie, {
      method: 'PATCH', body: JSON.stringify({ summary: 'Now with more stalls' }),
    })
    let loaded = await (await api(`/listings/${created.id}`, cookie)).json() as
      { listing: { venue_room: string | null } }
    expect(loaded.listing.venue_room).toBe('Stall 14')

    await api(`/listings/${created.id}`, cookie, {
      method: 'PATCH', body: JSON.stringify({ venue_room: null }),
    })
    loaded = await (await api(`/listings/${created.id}`, cookie)).json() as
      { listing: { venue_room: string | null } }
    expect(loaded.listing.venue_room).toBeNull()
  })

  it('is refused at submission when no venue was ever picked', async () => {
    const cookie = await signIn('room-orphan@example.np')
    const created = await (await listing(cookie, {
      title: 'Somewhere Unnamed', listing_type: 'free',
      venue_room: 'Hall B', starts_at: '2027-01-01T12:00:00Z',
      category_slugs: ['concerts'],
    })).json() as { id: string }

    const response = await api(`/listings/${created.id}/submit`, cookie, { method: 'POST' })
    expect(response.status).toBe(400)
    const body = await response.json() as
      { error: { code: string; fields: { field: string }[] } }
    expect(body.error.code).toBe('incomplete_listing')
    expect(body.error.fields.map((f) => f.field)).toContain('venue_room')
  })

  // A room stored and never read is write-only data. It reaches the public
  // listing beside the venue, not inside it: two listings share one venue and
  // are in different halls.
  it('reaches the public listing without becoming part of the venue', async () => {
    await env.DB.prepare(
      `UPDATE listings SET venue_room = 'Hall B' WHERE id = 'lst_soon'`,
    ).run()

    const response = await SELF.fetch('https://nepscene.test/api/catalog/listings/rock-night')
    const body = await response.json() as
      { venue_room: string | null; venue: { id: string; name: string } }
    expect(body.venue_room).toBe('Hall B')
    expect(body.venue.name).toBe('Purple Haze')
  })
})
