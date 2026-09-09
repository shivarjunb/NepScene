import { Hono } from 'hono'
import type { Env } from '../env'
import { rowsOf, withRoundTrips, writeSession } from '../lib/d1'
import { requirePermission, type AuthVariables } from '../identity/middleware'

/**
 * Everything the wizard needs to render its selects, in one request and one
 * round trip (#30).
 *
 * This endpoint exists because of a specific WaahTickets defect: `loadLookups`
 * fetched four independent lists in two stages, so opening the create form
 * cost a fetch waterfall for data that had nothing to do with each other. The
 * fix there was to collapse the stages; the lesson here is stronger — the four
 * lists never needed four requests either. One HTTP call, one `DB.batch`, five
 * statements.
 *
 * The primary is read rather than a replica: an organizer who has just created
 * a venue and reopened the wizard must see it, and a replica may not have it
 * yet. Authoring is low-traffic and correctness-first (docs/ARCHITECTURE.md).
 */
export const authorLookupRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/** Enough to fill a select. The venue *search* is #31; this is the starter set. */
const VENUE_SAMPLE = 50
const ARTIST_SAMPLE = 100
const TAG_SUGGESTIONS = 40

type CategoryRow = { slug: string; name: string; name_ne: string | null; icon: string | null; color: string | null }
type VenueRow = { id: string; name: string; area: string | null; city: string | null; latitude: number | null; longitude: number | null }
type ArtistRow = { slug: string; name: string }
type OrgRow = { id: string; name: string; org_role: string }
type TagRow = { slug: string; label: string }

authorLookupRoutes.get('/lookups', requirePermission('listing:create'), async (c) => {
  const user = c.get('user')
  const session = writeSession(c.env)

  // One statement per list, one batch, one round trip. Adding a sixth list
  // here is free; adding a sixth `await` is 200ms.
  const [categories, venues, artists, organizations, tags] = await session.batch([
    c.env.DB.prepare(
      `SELECT slug, name, name_ne, icon, color FROM categories
        WHERE is_active = 1 ORDER BY sort_order ASC`,
    ),
    // Ordered by how much has happened there: the venue an author wants is
    // overwhelmingly one that is already in use.
    c.env.DB.prepare(
      `SELECT v.id, v.name, v.area, v.city, v.latitude, v.longitude
         FROM venues v
         LEFT JOIN listings l ON l.venue_id = v.id
        GROUP BY v.id
        ORDER BY COUNT(l.id) DESC, v.name ASC
        LIMIT ?1`,
    ).bind(VENUE_SAMPLE),
    c.env.DB.prepare('SELECT slug, name FROM artists ORDER BY name ASC LIMIT ?1').bind(ARTIST_SAMPLE),
    // Only the organizations this author may publish on behalf of. An author
    // with none lists as themselves, which is what organization_id nullable is
    // for (migration 0001).
    c.env.DB.prepare(
      `SELECT o.id, o.name, ou.org_role
         FROM organizations o
         JOIN organization_users ou ON ou.organization_id = o.id
        WHERE ou.user_id = ?1
        ORDER BY o.name ASC`,
    ).bind(user.id),
    // Suggestions only — tags stay free-form, so this list never gates input.
    c.env.DB.prepare(
      `SELECT t.slug, t.label FROM tags t
         JOIN listing_tags lt ON lt.tag_slug = t.slug
        GROUP BY t.slug ORDER BY COUNT(*) DESC, t.label ASC LIMIT ?1`,
    ).bind(TAG_SUGGESTIONS),
  ])

  return withRoundTrips(Response.json({
    categories: rowsOf<CategoryRow>(categories),
    venues: rowsOf<VenueRow>(venues),
    artists: rowsOf<ArtistRow>(artists),
    organizations: rowsOf<OrgRow>(organizations),
    tags: rowsOf<TagRow>(tags),
    timezones: ['Asia/Kathmandu'],
  }), session)
})
