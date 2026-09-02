#!/usr/bin/env node
/**
 * Catalogue verification (#26) — referential integrity and anomaly reporting.
 *
 * D1 does not enforce foreign keys by default, so "the schema declares it"
 * is not evidence that the data obeys it. Integrity failures exit non-zero;
 * anomalies are reported and do not, because some are legitimate (a venue
 * awaiting coordinates) and some are a seed doing its job (draft listings).
 *
 * Usage:
 *   node scripts/verify-catalogue.mjs                # local
 *   node scripts/verify-catalogue.mjs --env staging  # remote
 */
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const envIndex = args.indexOf('--env')
const ENV = envIndex === -1 ? null : args[envIndex + 1]

// Nepal's bounding box, generously drawn. A listing outside it is a data entry
// error — most often swapped latitude and longitude.
const NEPAL = { minLat: 26.3, maxLat: 30.5, minLng: 80.0, maxLng: 88.3 }

/** Each returns rows that should not exist. */
const INTEGRITY = [
  ['listing_categories referencing a missing listing',
   'SELECT lc.listing_id FROM listing_categories lc LEFT JOIN listings l ON l.id = lc.listing_id WHERE l.id IS NULL'],
  ['listing_categories referencing a missing category',
   'SELECT lc.category_id FROM listing_categories lc LEFT JOIN categories c ON c.id = lc.category_id WHERE c.id IS NULL'],
  ['listing_artists referencing a missing listing or artist',
   'SELECT la.listing_id FROM listing_artists la LEFT JOIN listings l ON l.id = la.listing_id LEFT JOIN artists a ON a.id = la.artist_id WHERE l.id IS NULL OR a.id IS NULL'],
  ['listing_media referencing a missing listing',
   'SELECT m.id FROM listing_media m LEFT JOIN listings l ON l.id = m.listing_id WHERE l.id IS NULL'],
  ['listings referencing a missing venue',
   'SELECT l.id FROM listings l WHERE l.venue_id IS NOT NULL AND l.venue_id NOT IN (SELECT id FROM venues)'],
  ['listings referencing a missing organization',
   'SELECT l.id FROM listings l WHERE l.organization_id IS NOT NULL AND l.organization_id NOT IN (SELECT id FROM organizations)'],
  ['slug_redirects pointing at nothing',
   "SELECT r.old_slug FROM slug_redirects r WHERE r.entity_type = 'listing' AND r.entity_id NOT IN (SELECT id FROM listings)"],
  ['sessions belonging to a missing user',
   'SELECT s.id FROM user_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL'],
  ['duplicate slugs',
   'SELECT slug FROM listings GROUP BY slug HAVING COUNT(*) > 1'],
  ['a listing ending before it starts',
   'SELECT id FROM listings WHERE ends_at IS NOT NULL AND ends_at < starts_at'],
  ['a slug that is not URL-safe',
   "SELECT slug FROM listings WHERE slug GLOB '*[^a-z0-9-]*' OR slug = ''"],
]

const ANOMALIES = [
  ['published listings with no published_at',
   "SELECT id FROM listings WHERE status = 'published' AND published_at IS NULL"],
  ['published listings with no category',
   "SELECT id FROM listings WHERE status = 'published' AND id NOT IN (SELECT listing_id FROM listing_categories)"],
  ['listings with more than one primary category',
   'SELECT listing_id FROM listing_categories WHERE is_primary = 1 GROUP BY listing_id HAVING COUNT(*) > 1'],
  ['attendable listings with neither a venue nor coordinates',
   "SELECT id FROM listings WHERE listing_type != 'announcement' AND venue_id IS NULL AND location_lat IS NULL"],
  ['venues with no coordinates — invisible on the map',
   'SELECT id FROM venues WHERE latitude IS NULL OR longitude IS NULL'],
  ['coordinates outside Nepal — usually a swapped lat/lng',
   `SELECT id FROM venues WHERE latitude IS NOT NULL AND (latitude NOT BETWEEN ${NEPAL.minLat} AND ${NEPAL.maxLat} OR longitude NOT BETWEEN ${NEPAL.minLng} AND ${NEPAL.maxLng})`],
  ['media with no alt text — a WCAG failure on render',
   "SELECT id FROM listing_media WHERE alt_text IS NULL OR TRIM(alt_text) = ''"],
  ['offers with a price but nowhere to buy',
   'SELECT id FROM listings WHERE offer_price_from_paisa IS NOT NULL AND offer_url IS NULL'],
  // The publication guard lives in the UPDATE (migration 0004 explains why it
  // cannot be a trigger), so a direct SQL write can bypass it. This is how such
  // a bypass is found: anything authored through the product and published
  // leaves an audit row, and anything published without one did not come
  // through the workflow. Seeded and imported listings are excluded — they are
  // published by definition, not by a person.
  ['published listings with no publication in the audit trail',
   `SELECT l.id FROM listings l
     WHERE l.status = 'published'
       AND l.source IN ('organizer', 'submission')
       AND NOT EXISTS (SELECT 1 FROM audit_log a
                        WHERE a.entity_type = 'listing' AND a.entity_id = l.id
                          AND a.action = 'published')`],
]

function query(sql) {
  const wranglerArgs = ['wrangler', 'd1', 'execute', ENV ? 'DB' : 'nepscene-local']
  if (ENV) wranglerArgs.push('--env', ENV, '--remote')
  else wranglerArgs.push('--local')
  wranglerArgs.push('--command', sql, '--json')
  const out = execFileSync('npx', wranglerArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out.slice(out.indexOf('[')))[0].results
}

function run(title, checks, { fatal }) {
  console.log(`\n${title}`)
  let failures = 0
  for (const [name, sql] of checks) {
    const rows = query(sql)
    if (rows.length === 0) {
      console.log(`  ok    ${name}`)
    } else {
      failures++
      const label = fatal ? 'FAIL ' : 'warn '
      console.log(`  ${label} ${name}: ${rows.length}`)
      for (const row of rows.slice(0, 5)) console.log(`          ${JSON.stringify(row)}`)
      if (rows.length > 5) console.log(`          …and ${rows.length - 5} more`)
    }
  }
  return failures
}

const counts = query(`SELECT
  (SELECT COUNT(*) FROM listings) listings,
  (SELECT COUNT(*) FROM listings WHERE status = 'published') published,
  (SELECT COUNT(*) FROM venues) venues,
  (SELECT COUNT(*) FROM organizations) organizations,
  (SELECT COUNT(*) FROM categories) categories,
  (SELECT COUNT(*) FROM listing_media) media,
  (SELECT COUNT(*) FROM users) users`)[0]

console.log(`Catalogue: ${ENV ?? 'local'}`)
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(15)} ${v}`)

const broken = run('Referential integrity', INTEGRITY, { fatal: true })
run('Anomalies', ANOMALIES, { fatal: false })

console.log(broken === 0
  ? '\nIntegrity: clean.'
  : `\nIntegrity: ${broken} check(s) failed.`)
process.exit(broken === 0 ? 0 : 1)
