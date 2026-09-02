import { env } from 'cloudflare:test'

/**
 * A small, fully deterministic catalogue for assertions. The demo seed in
 * scripts/ is for developing against; this one exists so a test can say
 * "exactly four listings are upcoming" and mean it.
 */
const iso = (daysFromNow: number, hour = 12) => {
  const date = new Date(Date.now() + daysFromNow * 86_400_000)
  date.setUTCHours(hour, 0, 0, 0)
  return date.toISOString()
}

export const fixtures = {
  soon: iso(2),
  later: iso(9),
  muchLater: iso(30),
  past: iso(-10),
  runningStart: iso(-1),
  runningEnd: iso(1),
}

export async function seedCatalogue(): Promise<void> {
  const now = new Date().toISOString()

  await env.DB.batch([
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM slug_redirects'),
    env.DB.prepare('DELETE FROM listing_artists'),
    env.DB.prepare('DELETE FROM listing_categories'),
    env.DB.prepare('DELETE FROM listing_media'),
    env.DB.prepare('DELETE FROM listings'),
    env.DB.prepare('DELETE FROM artists'),
    env.DB.prepare('DELETE FROM venues'),
    env.DB.prepare('DELETE FROM organizations'),
  ])

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations (id, slug, name, is_verified, created_at, updated_at)
       VALUES ('org_a', 'himalayan-sound', 'Himalayan Sound', 1, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO venues (id, slug, name, area, city, district, province, latitude, longitude, created_at, updated_at)
       VALUES ('ven_thamel', 'purple-haze', 'Purple Haze', 'Thamel', 'Kathmandu', 'Kathmandu', 'Bagmati', 27.7154, 85.3105, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO venues (id, slug, name, area, city, district, province, latitude, longitude, created_at, updated_at)
       VALUES ('ven_pokhara', 'lakeside', 'Lakeside', 'Baidam', 'Pokhara', 'Kaski', 'Gandaki', 28.2096, 83.9556, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO artists (id, slug, name, created_at, updated_at)
       VALUES ('art_a', 'kutumba', 'Kutumba', ?1, ?1)`,
    ).bind(now),
  ])

  const listing = (
    id: string, slug: string, title: string, type: string, source: string,
    status: string, org: string | null, venue: string | null,
    startsAt: string, endsAt: string | null, featured = 0,
  ) =>
    env.DB.prepare(
      `INSERT INTO listings
        (id, slug, title, summary, listing_type, source, status, organization_id, venue_id,
         starts_at, ends_at, is_featured, published_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?13)`,
    ).bind(id, slug, title, `${title} summary`, type, source, status, org, venue,
           startsAt, endsAt, featured, now)

  await env.DB.batch([
    listing('lst_soon', 'rock-night', 'Rock Night', 'ticketed_internal', 'organizer',
            'published', 'org_a', 'ven_thamel', fixtures.soon, null, 1),
    listing('lst_later', 'lakeside-live', 'Lakeside Live', 'ticketed_external', 'organizer',
            'published', 'org_a', 'ven_pokhara', fixtures.later, null),
    listing('lst_free', 'lake-cleanup', 'Lake Clean-up', 'free', 'submission',
            'published', null, 'ven_pokhara', fixtures.muchLater, null),
    listing('lst_running', 'art-week', 'Art Week', 'free', 'editorial',
            'published', 'org_a', 'ven_thamel', fixtures.runningStart, fixtures.runningEnd),
    listing('lst_past', 'finished-gig', 'Finished Gig', 'ticketed_internal', 'organizer',
            'published', 'org_a', 'ven_thamel', fixtures.past, null),
    listing('lst_draft', 'secret-draft', 'Secret Draft', 'free', 'organizer',
            'draft', 'org_a', 'ven_thamel', fixtures.soon, null),
    listing('lst_pending', 'awaiting-review', 'Awaiting Review', 'free', 'submission',
            'pending_review', null, 'ven_pokhara', fixtures.soon, null),
  ])

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE listings SET offer_url = 'https://waahtickets.example/e/rock-night',
        offer_provider = 'waahtickets', offer_price_from_paisa = 80000,
        offer_checked_at = ?1 WHERE id = 'lst_soon'`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO listing_categories (listing_id, category_id, is_primary)
       VALUES ('lst_soon', 'cat_concert', 1), ('lst_soon', 'cat_nightlife', 0),
              ('lst_later', 'cat_concert', 1), ('lst_free', 'cat_community', 1),
              ('lst_running', 'cat_arts', 1), ('lst_past', 'cat_concert', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO listing_artists (listing_id, artist_id, billing_order)
       VALUES ('lst_soon', 'art_a', 0)`,
    ),
    env.DB.prepare(
      `INSERT INTO slug_redirects (entity_type, old_slug, entity_id, created_at)
       VALUES ('listing', 'rock-night-2025', 'lst_soon', ?1)`,
    ).bind(now),
  ])
}

/** The four listings a default public read must return, in start order. */
export const UPCOMING_SLUGS = ['art-week', 'rock-night', 'lakeside-live', 'lake-cleanup']
