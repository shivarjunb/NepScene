#!/usr/bin/env node
/**
 * WaahTickets → NepScene catalogue import (#20, #21).
 *
 * Reads the WaahTickets D1 read-only, reshapes it around listings and canonical
 * venues, and reports what it did. Nothing is written back to the source.
 *
 * Two reshapes matter:
 *
 *   events           -> listings   with a listing_type inferred from whether
 *                                  the event has ticket types, and source
 *                                  'import' so provenance is never guessed at
 *   event_locations  -> venues     deduplicated by name and position, because
 *                                  47 rows describe fewer real places and a
 *                                  venue has to own a page
 *
 * Usage:
 *   node scripts/import-waahtickets.mjs --dry-run
 *   node scripts/import-waahtickets.mjs
 *   node scripts/import-waahtickets.mjs --env staging
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const DRY_RUN = args.includes('--dry-run')
const ENV = arg('env', null)
// The source database is addressed by uuid, so this script has no dependency on
// the WaahTickets repository being checked out anywhere.
const SOURCE = arg('source', '8382ba7d-a43d-41e1-896d-8d897aeb5f11')

const CATEGORY_BY_EVENT_TYPE = {
  concert: 'cat_concert',    festival: 'cat_festival',  sports: 'cat_sports',
  comedy: 'cat_comedy',      food: 'cat_food',          nightlife: 'cat_nightlife',
  workshop: 'cat_workshop',  conference: 'cat_workshop',
  community: 'cat_community', college: 'cat_community',
}

function query(database, sql, { remote = true, env = null } = {}) {
  const wranglerArgs = ['wrangler', 'd1', 'execute', database]
  // A binding name like DB only resolves inside its environment.
  if (env) wranglerArgs.push('--env', env)
  if (remote) wranglerArgs.push('--remote')
  else wranglerArgs.push('--local')
  wranglerArgs.push('--command', sql, '--json')
  const out = execFileSync('npx', wranglerArgs, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out.slice(out.indexOf('[')))[0].results
}

const esc = (v) => (v === null || v === undefined || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

const repairs = []

/**
 * An end before its start is an overnight event whose end time lost a day —
 * "19:00 to 00:00" means midnight tonight, not midnight this morning. Repaired
 * rather than imported broken, and rather than dropped: both alternatives lose
 * something. Anything more than a day out is left alone and reported, because
 * that is not this bug.
 */
function repairOvernight(listing) {
  if (!listing.ends_at || !listing.starts_at || listing.ends_at >= listing.starts_at) return listing
  const start = Date.parse(listing.starts_at)
  const end = Date.parse(listing.ends_at)
  if (start - end < 24 * 60 * 60 * 1000) {
    const fixed = new Date(end + 24 * 60 * 60 * 1000).toISOString()
    repairs.push(`${listing.id}: ends_at ${listing.ends_at} -> ${fixed} (overnight)`)
    return { ...listing, ends_at: fixed }
  }
  repairs.push(`${listing.id}: ends_at ${listing.ends_at} is before starts_at by more than a day — left as is`)
  return listing
}

/** WaahTickets stores 'YYYY-MM-DD HH:MM:SS' local time; NepScene stores ISO-8601 UTC. */
function toIso(value) {
  if (!value) return null
  const text = String(value).trim()
  if (text.includes('T') && text.endsWith('Z')) return text
  const [date, time = '00:00:00'] = text.split(/[ T]/)
  return `${date}T${time.slice(0, 8)}Z`
}

const slugify = (text) =>
  String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)

console.log(`Reading WaahTickets (${SOURCE})…`)

const events = query(SOURCE, `
  SELECT e.id, e.name, e.slug, e.description, e.event_type, e.status,
         e.start_datetime, e.end_datetime, e.location_lat, e.location_lng,
         e.map_pin_icon, e.map_popup_config, e.organization_id, e.created_at, e.updated_at,
         (SELECT COUNT(*) FROM ticket_types t WHERE t.event_id = e.id) AS ticket_types,
         (SELECT MIN(t.price_paisa) FROM ticket_types t WHERE t.event_id = e.id) AS min_price,
         (SELECT a.event_location_id FROM event_location_assignments a WHERE a.event_id = e.id LIMIT 1) AS location_id
    FROM events e`)

const locations = query(SOURCE, `
  SELECT id, name, address, latitude, longitude, total_capacity FROM event_locations`)

const organizations = query(SOURCE, `
  SELECT id, name, legal_name, contact_email, contact_phone, created_at, updated_at
    FROM organizations`)

console.log(`  ${events.length} events, ${locations.length} locations, ${organizations.length} organizations`)

// ─── Venues: deduplicate ─────────────────────────────────────────────────────
// Same name at the same place is the same venue, however many rows describe it.
// Coordinates are rounded to ~10m so that trivially different pins collapse.
const venueKey = (loc) =>
  `${slugify(loc.name)}@${(loc.latitude ?? 0).toFixed(4)},${(loc.longitude ?? 0).toFixed(4)}`

const venues = new Map()          // key -> venue
const venueIdByLocationId = new Map()

for (const loc of locations) {
  const key = venueKey(loc)
  if (!venues.has(key)) {
    const slug = slugify(loc.name) || `venue-${venues.size + 1}`
    venues.set(key, {
      id: `wt_ven_${venues.size + 1}`,
      slug,
      name: loc.name,
      address: loc.address ?? null,
      // "Lazimpat, Kathmandu 44600" -> area Lazimpat, city Kathmandu
      area: (loc.address ?? '').split(',')[0]?.trim() || null,
      city: (loc.address ?? '').split(',')[1]?.trim().replace(/\s+\d{5}$/, '') || null,
      latitude: loc.latitude ?? null,
      longitude: loc.longitude ?? null,
      capacity: loc.total_capacity ?? null,
      sources: [],
    })
  }
  const venue = venues.get(key)
  venue.sources.push(loc.id)
  venueIdByLocationId.set(loc.id, venue.id)
}

const deduped = locations.length - venues.size
console.log(`  ${locations.length} locations deduplicate to ${venues.size} venues (${deduped} merged)`)

// Slugs must still be unique after dedupe.
const usedSlugs = new Set()
for (const venue of venues.values()) {
  let slug = venue.slug, n = 2
  while (usedSlugs.has(slug)) slug = `${venue.slug}-${n++}`
  usedSlugs.add(slug)
  venue.slug = slug
}

// ─── Listings ────────────────────────────────────────────────────────────────
const listingSlugs = new Set()
const listings = events.map((event, index) => repairOvernight(buildListing(event, index)))

function buildListing(event, index) {
  let slug = slugify(event.slug || event.name) || `imported-listing-${index + 1}`
  let candidate = slug, n = 2
  while (listingSlugs.has(candidate)) candidate = `${slug}-${n++}`
  listingSlugs.add(candidate)

  const ticketed = (event.ticket_types ?? 0) > 0
  const venueId = event.location_id ? venueIdByLocationId.get(event.location_id) ?? null : null

  return {
    id: `wt_${event.id}`,
    slug: candidate,
    title: event.name,
    description: event.description ?? null,
    // Everything sellable in WaahTickets stays sellable there; NepScene links out.
    listing_type: ticketed ? 'ticketed_internal' : 'free',
    source: 'import',
    status: event.status === 'published' ? 'published' : 'draft',
    organization_id: event.organization_id ? `wt_org_${event.organization_id}` : null,
    venue_id: venueId,
    starts_at: toIso(event.start_datetime),
    ends_at: toIso(event.end_datetime),
    location_lat: event.location_lat ?? null,
    location_lng: event.location_lng ?? null,
    map_pin_icon: event.map_pin_icon ?? null,
    map_popup_config: event.map_popup_config ?? null,
    offer_url: ticketed ? `https://waahtickets.bhattarai-shiva.workers.dev/e/${event.slug}` : null,
    offer_provider: ticketed ? 'waahtickets' : null,
    offer_price_from_paisa: ticketed ? event.min_price ?? null : null,
    category_id: CATEGORY_BY_EVENT_TYPE[event.event_type] ?? 'cat_community',
    published_at: event.status === 'published' ? toIso(event.created_at) : null,
    created_at: toIso(event.created_at) ?? new Date().toISOString(),
    updated_at: toIso(event.updated_at) ?? new Date().toISOString(),
    source_event: event,
  }
}

// ─── Loss check, before anything is written ──────────────────────────────────
const problems = []
if (listings.length !== events.length) problems.push(`event count changed: ${events.length} -> ${listings.length}`)
for (const listing of listings) {
  if (!listing.title) problems.push(`${listing.id}: lost its title`)
  if (!listing.starts_at) problems.push(`${listing.id}: lost its start time`)
  if (listing.source_event.location_id && !listing.venue_id) {
    problems.push(`${listing.id}: had a location and lost it`)
  }
  if (!/^[a-z0-9-]+$/.test(listing.slug)) problems.push(`${listing.id}: unusable slug "${listing.slug}"`)
}
if (problems.length > 0) {
  console.error('\nRefusing to import — the transform loses data:')
  for (const p of problems.slice(0, 20)) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`  ${listings.length} listings, no data loss detected`)
if (repairs.length > 0) {
  console.log(`  ${repairs.length} repaired on the way in:`)
  for (const r of repairs) console.log(`    ${r}`)
}

// ─── SQL ─────────────────────────────────────────────────────────────────────
const now = new Date().toISOString()
const sql = [
  '-- Generated by scripts/import-waahtickets.mjs — regenerate, do not edit.',
  "DELETE FROM listing_categories WHERE listing_id LIKE 'wt_%';",
  "DELETE FROM listing_media WHERE listing_id LIKE 'wt_%';",
  "DELETE FROM listings WHERE id LIKE 'wt_%';",
  "DELETE FROM venues WHERE id LIKE 'wt_ven_%';",
  "DELETE FROM organizations WHERE id LIKE 'wt_org_%';",
]

sql.push(
  'INSERT INTO organizations (id, slug, name, legal_name, contact_email, contact_phone, created_at, updated_at) VALUES',
  organizations.map((org) => {
    let slug = slugify(org.name) || org.id
    return `(${esc(`wt_org_${org.id}`)}, ${esc(slug)}, ${esc(org.name)}, ${esc(org.legal_name)}, ` +
           `${esc(org.contact_email)}, ${esc(org.contact_phone)}, ${esc(toIso(org.created_at) ?? now)}, ${esc(toIso(org.updated_at) ?? now)})`
  }).join(',\n') + ';',
)

sql.push(
  'INSERT INTO venues (id, slug, name, address, area, city, latitude, longitude, capacity, created_at, updated_at) VALUES',
  [...venues.values()].map((v) =>
    `(${esc(v.id)}, ${esc(v.slug)}, ${esc(v.name)}, ${esc(v.address)}, ${esc(v.area)}, ${esc(v.city)}, ` +
    `${v.latitude ?? 'NULL'}, ${v.longitude ?? 'NULL'}, ${v.capacity ?? 'NULL'}, ${esc(now)}, ${esc(now)})`,
  ).join(',\n') + ';',
)

for (let i = 0; i < listings.length; i += 50) {
  sql.push(
    'INSERT INTO listings (id, slug, title, description, listing_type, source, status,' +
    ' organization_id, venue_id, starts_at, ends_at, location_lat, location_lng, map_pin_icon,' +
    ' map_popup_config, offer_url, offer_provider, offer_price_from_paisa, published_at,' +
    ' created_at, updated_at) VALUES',
    listings.slice(i, i + 50).map((l) =>
      `(${esc(l.id)}, ${esc(l.slug)}, ${esc(l.title)}, ${esc(l.description)}, ${esc(l.listing_type)}, ` +
      `${esc(l.source)}, ${esc(l.status)}, ${esc(l.organization_id)}, ${esc(l.venue_id)}, ` +
      `${esc(l.starts_at)}, ${esc(l.ends_at)}, ${l.location_lat ?? 'NULL'}, ${l.location_lng ?? 'NULL'}, ` +
      `${esc(l.map_pin_icon)}, ${esc(l.map_popup_config)}, ${esc(l.offer_url)}, ${esc(l.offer_provider)}, ` +
      `${l.offer_price_from_paisa ?? 'NULL'}, ${esc(l.published_at)}, ${esc(l.created_at)}, ${esc(l.updated_at)})`,
    ).join(',\n') + ';',
  )
  sql.push(
    'INSERT OR IGNORE INTO listing_categories (listing_id, category_id, is_primary) VALUES',
    listings.slice(i, i + 50).map((l) => `(${esc(l.id)}, ${esc(l.category_id)}, 1)`).join(',\n') + ';',
  )
}

const file = join(mkdtempSync(join(tmpdir(), 'nepscene-import-')), 'import.sql')
writeFileSync(file, sql.join('\n'))

const byType = {}
for (const l of listings) byType[l.listing_type] = (byType[l.listing_type] ?? 0) + 1
console.log(`  listing types: ${JSON.stringify(byType)}`)
console.log(`  SQL written to ${file}`)

if (DRY_RUN) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}

const target = ENV ? ['DB', '--env', ENV, '--remote'] : ['nepscene-local', '--local']
console.log(`\nImporting into ${ENV ?? 'local'}…`)
execFileSync('npx', ['wrangler', 'd1', 'execute', ...target, `--file=${file}`], { stdio: 'ignore' })

const check = query(ENV ? 'DB' : 'nepscene-local', `
  SELECT (SELECT COUNT(*) FROM listings WHERE id LIKE 'wt_%') listings,
         (SELECT COUNT(*) FROM venues WHERE id LIKE 'wt_ven_%') venues,
         (SELECT COUNT(*) FROM listings WHERE id LIKE 'wt_%' AND venue_id IS NULL) without_venue`,
  { remote: Boolean(ENV), env: ENV })[0]

console.log(`Imported: ${check.listings} listings, ${check.venues} venues, ${check.without_venue} without a venue`)
if (check.listings !== events.length) {
  console.error(`MISMATCH: expected ${events.length} listings, found ${check.listings}`)
  process.exit(1)
}
console.log('Every source event is present.')
