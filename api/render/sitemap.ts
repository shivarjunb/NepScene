import type { Env } from '../env'
import { readSession } from '../lib/d1'

/**
 * Sitemaps (#45), segmented, and generated rather than stored.
 *
 * **Why generated on request.** A stored sitemap is a file that has to be
 * rewritten whenever anything publishes, and the failure mode is silent: it
 * goes stale and the new listings are simply never crawled. The catalogue can
 * answer "every published slug, newest first" in one indexed query, so the
 * sitemap is a read like any other and cannot disagree with the site.
 *
 * **Why segmented at 50,000.** That is the protocol's limit — a sitemap with
 * more URLs is rejected whole, not truncated — and the index at `/sitemap.xml`
 * is what points at the segments. The threshold is enforced here rather than
 * assumed, because it is exactly the kind of ceiling nobody notices crossing.
 */
export const URLS_PER_SITEMAP = 50_000

/** Static pages worth crawling. `/search` is not among them, by design. */
const STATIC_PATHS = ['/', '/venues', '/organizers', '/about', '/privacy']

type Entry = { path: string; lastmod?: string | null; changefreq?: string; priority?: string }

const xmlEscape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

function urlset(origin: string, entries: Entry[]): string {
  const body = entries.map((entry) => {
    const parts = [`<loc>${xmlEscape(origin + entry.path)}</loc>`]
    if (entry.lastmod) parts.push(`<lastmod>${xmlEscape(entry.lastmod.slice(0, 10))}</lastmod>`)
    if (entry.changefreq) parts.push(`<changefreq>${entry.changefreq}</changefreq>`)
    if (entry.priority) parts.push(`<priority>${entry.priority}</priority>`)
    // The Nepali variant is a distinct URL, so it is declared as an alternate
    // rather than left for a crawler to guess at (#46).
    parts.push(
      `<xhtml:link rel="alternate" hreflang="ne" href="${xmlEscape(`${origin}${entry.path}${entry.path.includes('?') ? '&' : '?'}lang=ne`)}"/>`,
      `<xhtml:link rel="alternate" hreflang="en" href="${xmlEscape(origin + entry.path)}"/>`,
    )
    return `<url>${parts.join('')}</url>`
  }).join('')

  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'
    + ' xmlns:xhtml="http://www.w3.org/1999/xhtml">'
    + `${body}</urlset>`
}

const xml = (body: string) => new Response(body, {
  headers: {
    'content-type': 'application/xml; charset=utf-8',
    // An hour: long enough that a crawler's repeat fetch is free, short enough
    // that a listing published this morning is in it this afternoon.
    'cache-control': 'public, max-age=3600, s-maxage=3600',
  },
})

/** How many of each kind there are, so the index knows how many segments. */
async function counts(env: Env): Promise<{ listings: number; venues: number; organizers: number }> {
  const session = readSession(env)
  const now = new Date().toISOString()
  const [rows] = await session.batch<{ listings: number; venues: number; organizers: number }>([
    {
      sql: `SELECT
              (SELECT COUNT(*) FROM listings l
                WHERE l.status = 'published'
                  AND COALESCE(l.ends_at, l.starts_at) >= ?1) AS listings,
              (SELECT COUNT(*) FROM venues v
                WHERE EXISTS (SELECT 1 FROM listings l
                               WHERE l.venue_id = v.id AND l.status = 'published')) AS venues,
              (SELECT COUNT(*) FROM organizations o
                WHERE EXISTS (SELECT 1 FROM listings l
                               WHERE l.organization_id = o.id
                                 AND l.status = 'published')) AS organizers`,
      params: [now],
    },
  ])
  const row = rows?.[0]
  return {
    listings: row?.listings ?? 0,
    venues: row?.venues ?? 0,
    organizers: row?.organizers ?? 0,
  }
}

const segments = (total: number) => Math.max(1, Math.ceil(total / URLS_PER_SITEMAP))

/** `/sitemap.xml` — the index, which is the only URL that has to be submitted. */
export async function sitemapIndex(env: Env, origin: string): Promise<Response> {
  const total = await counts(env)
  const children: string[] = ['pages']
  for (let page = 1; page <= segments(total.listings); page++) children.push(`listings-${page}`)
  for (let page = 1; page <= segments(total.venues); page++) children.push(`venues-${page}`)
  for (let page = 1; page <= segments(total.organizers); page++) children.push(`organizers-${page}`)

  const body = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + children.map((name) => `<sitemap><loc>${xmlEscape(`${origin}/sitemaps/${name}.xml`)}</loc></sitemap>`).join('')
    + '</sitemapindex>'
  return xml(body)
}

/**
 * One segment. `name` is `<kind>-<page>` or `pages`, and anything else is a
 * 404 rather than an empty sitemap — an empty one tells a crawler the section
 * exists and is empty, which is a different and wrong claim.
 */
export async function sitemapSegment(
  env: Env, origin: string, name: string,
): Promise<Response | null> {
  if (name === 'pages') {
    return xml(urlset(origin, STATIC_PATHS.map((path) => ({
      path, changefreq: 'daily', priority: path === '/' ? '1.0' : '0.6',
    }))))
  }

  const match = /^(listings|venues|organizers)-(\d+)$/.exec(name)
  if (!match) return null
  const kind = match[1] as 'listings' | 'venues' | 'organizers'
  const page = Number(match[2])
  if (!Number.isInteger(page) || page < 1) return null

  const session = readSession(env)
  const now = new Date().toISOString()
  const offset = (page - 1) * URLS_PER_SITEMAP

  // OFFSET rather than a keyset cursor, deliberately: a sitemap segment is
  // addressed by number, so page 7 has to mean the same rows every time it is
  // fetched. Nothing here is a hot path — a crawler reads it hourly at most.
  const statements = {
    listings: {
      sql: `SELECT l.slug AS slug, l.updated_at AS lastmod FROM listings l
             WHERE l.status = 'published' AND COALESCE(l.ends_at, l.starts_at) >= ?1
             ORDER BY l.starts_at ASC, l.id ASC LIMIT ?2 OFFSET ?3`,
      params: [now, URLS_PER_SITEMAP, offset],
    },
    venues: {
      sql: `SELECT v.slug AS slug, v.updated_at AS lastmod FROM venues v
             WHERE EXISTS (SELECT 1 FROM listings l
                            WHERE l.venue_id = v.id AND l.status = 'published')
             ORDER BY v.slug ASC LIMIT ?1 OFFSET ?2`,
      params: [URLS_PER_SITEMAP, offset],
    },
    organizers: {
      sql: `SELECT o.slug AS slug, o.updated_at AS lastmod FROM organizations o
             WHERE EXISTS (SELECT 1 FROM listings l
                            WHERE l.organization_id = o.id AND l.status = 'published')
             ORDER BY o.slug ASC LIMIT ?1 OFFSET ?2`,
      params: [URLS_PER_SITEMAP, offset],
    },
  }[kind]

  const rows = await session.all<{ slug: string; lastmod: string | null }>(
    statements.sql, statements.params,
  )
  if (rows.length === 0 && page > 1) return null

  const prefix = kind === 'organizers' ? '/organizers' : kind === 'venues' ? '/venues' : '/listings'
  return xml(urlset(origin, rows.map((row) => ({
    path: `${prefix}/${row.slug}`,
    lastmod: row.lastmod,
    changefreq: kind === 'listings' ? 'daily' : 'weekly',
    priority: kind === 'listings' ? '0.8' : '0.5',
  }))))
}

/**
 * `robots.txt`.
 *
 * `/search` is disallowed and `/api/` with it. A crawler that follows filter
 * links generates a URL per combination, and a catalogue of a few thousand
 * listings becomes millions of thin, near-duplicate pages that spend the crawl
 * budget the listing pages need. The pages themselves also carry `noindex`, so
 * the two agree.
 *
 * A preview or staging deployment disallows everything. Two hostnames serving
 * the same catalogue is duplicate content, and the one nobody meant to publish
 * is the one that ranks.
 */
export function robots(env: Env, origin: string): Response {
  const isProduction = env.ENVIRONMENT === 'production'
  const body = isProduction
    ? [
        'User-agent: *',
        'Allow: /',
        'Disallow: /api/',
        'Disallow: /search',
        'Disallow: /submit',
        'Disallow: /dashboard',
        'Disallow: /moderate',
        '',
        `Sitemap: ${origin}/sitemap.xml`,
        '',
      ].join('\n')
    : ['User-agent: *', 'Disallow: /', ''].join('\n')

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
