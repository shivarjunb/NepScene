import { createHash } from 'node:crypto'

export const ORIGIN = 'https://katajaam.com'
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 24)
export const decode = (s = '') => String(s).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, v) => {
  if (v[0] === '#') {
    const n = v[1].toLowerCase() === 'x' ? parseInt(v.slice(2), 16) : Number(v.slice(1))
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[v.toLowerCase()] ?? m
})
const clean = (s) => decode(decode(s)).trim()
export const normal = (s) => clean(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
const titleKey = (s) => normal(s).split(' ').filter((t) => !['the', 'a', 'an', 'and', 'for'].includes(t))
  .map((t) => t === 'reliefs' ? 'relief' : t).join(' ')
const slug = (s) => normal(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'event'
const safeUrl = (value) => {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null } catch { return null }
}
export function sourceUrl(value) {
  const u = new URL(value, ORIGIN)
  if (u.origin !== ORIGIN || !/^\/events\/[^/]+$/.test(u.pathname)) throw Error(`Invalid event URL: ${value}`)
  u.search = ''; u.hash = ''; return u.href
}
function attrs(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((m) => [m[1].toLowerCase(), decode(m[2] ?? m[3])]))
}
export function listingPage(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
  if (!main) throw Error('Kata Jaam listing page has no main element')
  const links = [...main.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
  const urls = links.filter((m) => /<h3\b/i.test(m[2]) && /<img\b/i.test(m[2]))
    .map((m) => attrs(m[1]).href).filter((u) => u?.startsWith('/events/')).map(sourceUrl)
  const nextHref = links.find((m) => clean(m[2].replace(/<[^>]+>/g, '')) === 'Next')
  let next = nextHref ? new URL(attrs(nextHref[1]).href, ORIGIN) : null
  if (next && (next.origin !== ORIGIN || next.pathname !== '/events')) throw Error('Unexpected pagination URL')
  const visible = main.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')
  const count = visible.match(/(\d+)\s+events?\s+across\s+the\s+valley/)
    ?? visible.match(/(?:Browse all events|Events)\s+(\d+)\s+events?\b/i)
  if (!count) throw Error('Cannot verify Kata Jaam inventory count; refusing a partial import')
  return { urls, next: next?.href ?? null, count: Number(count[1]) }
}
function flattenLd(v) {
  if (Array.isArray(v)) return v.flatMap(flattenLd)
  if (v && typeof v === 'object') return [v, ...flattenLd(v['@graph'] ?? [])]
  return []
}
export function eventPage(html, url) {
  const objects = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => attrs(m[1]).type === 'application/ld+json')
    .flatMap((m) => flattenLd(JSON.parse(m[2])))
  const events = objects.filter((o) => [o['@type']].flat().some((t) => /^(Event|MusicEvent|SportsEvent|Festival)$/.test(t)))
  const event = events.find((o) => o.url && sourceUrl(o.url) === sourceUrl(url)) ?? (events.length === 1 ? events[0] : null)
  if (!event) throw Error(`No unambiguous Event JSON-LD on ${url}`)
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? ''
  // Restrict TBD detection to this event, before related-event recommendations.
  const own = main.split(/<h2\b[^>]*>\s*(?:More|Keep exploring)/i)[0]
  const text = clean(own.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '\n'))
  const glance = text.match(/At a glance\s+When\s+([^\n]+)/i)?.[1] ?? ''
  const crumb = objects.find((o) => o['@type'] === 'BreadcrumbList')
  const category = crumb?.itemListElement?.find((x) => String(x.item).includes('/category/'))?.name?.replace(/ Events$/, '') ?? ''
  return { ...event, url: sourceUrl(url), category, page_text: text,
    date_tbd: /to be decided|to be announced/i.test(glance) || /EventPostponed|EventCancelled/.test(event.eventStatus ?? '') }
}
export async function crawl(read) {
  const sitemap = await read(`${ORIGIN}/sitemap.xml`)
  const sitemapUrls = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1])))
  const urls = new Set(), pages = new Set()
  let next = `${ORIGIN}/events`, expected
  while (next) {
    if (pages.has(next) || pages.size >= 100) throw Error('Pagination loop or unexpected page count')
    pages.add(next)
    let page
    try { page = listingPage(await read(next)) } catch (e) { throw Error(`${next}: ${e.message}`, { cause: e }) }
    if (expected !== undefined && page.count !== expected) throw Error('Inventory changed during scrape; run again')
    expected = page.count
    for (const u of page.urls) urls.add(u)
    next = page.next
  }
  if (!urls.size || urls.size !== expected) throw Error(`Inventory incomplete: found ${urls.size}, expected ${expected}`)
  const events = []
  // Sequential requests deliberately keep the public site load low.
  for (const url of urls) {
    const e = eventPage(await read(url), url)
    e.in_sitemap = sitemapUrls.has(url)
    events.push(e)
  }
  return { checked_at: new Date().toISOString(), count: events.length, pages: [...pages], events }
}
const categoryMap = {
  Music: 'cat_concert', 'Nightlife & Parties': 'cat_nightlife', 'Screenings & Watch Parties': 'cat_film',
  'Sports & Fitness': 'cat_sports', 'Theatre & Comedy': 'cat_arts', 'Art & Exhibitions': 'cat_arts',
  'Food & Drink': 'cat_food', 'Festivals & Culture': 'cat_festival', 'Outdoors & Hikes': 'cat_sports',
  'Tech & Business': 'cat_workshop', 'Learning & Workshops': 'cat_workshop', 'Community & Meetups': 'cat_community',
}
const finite = (n, max) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max ? n : null
const instant = (s) => typeof s === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(s) && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null
export function transform(raw, overrides = {}, publish = false, now = new Date().toISOString()) {
  const url = sourceUrl(raw.url), id = decode(new URL(url).pathname.slice(8))
  if (!raw.name || /^(test|test event|demo event)$/i.test(clean(raw.name))) return { skip: 'test or empty event', url }
  if (overrides.skip) return { skip: 'manual exclusion', url }
  const title = clean(overrides.title ?? raw.name)
  const notes = [], warnings = []
  const text = raw.page_text ?? ''
  const dateUnknown = raw.date_tbd || /At a glance\s+When\s+To be decided/i.test(text)
  let starts = overrides.starts_at === undefined ? raw.startDate : overrides.starts_at
  if (dateUnknown && overrides.starts_at === undefined) { starts = null; warnings.push('Date unannounced or postponed; stale structured date ignored') }
  // Many source records use midnight for "unknown time". Never invent midnight.
  if (starts && /T00:00(?::00)?(?:[+-]|Z)/.test(starts) && !overrides.confirm_midnight) {
    notes.push(`Source calendar date: ${starts.slice(0, 10)}; time not confirmed`)
    starts = null; warnings.push('Midnight may be a placeholder; date/time requires review')
  }
  const starts_at = instant(starts)
  if (!starts_at) warnings.push('Missing valid start date/time')
  let ends_at = instant(overrides.ends_at === undefined ? raw.endDate : overrides.ends_at)
  if (!starts_at) ends_at = null
  if (ends_at && ends_at <= starts_at) { ends_at = null; warnings.push('End is not after start; discarded') }
  const location = raw.location ?? {}, address = location.address ?? {}
  const venueName = clean(overrides.venue ?? location.name ?? '')
  const missingVenue = !venueName || /venue.*(?:announced|tba)|^venue tba$/i.test(venueName)
  const latitude = finite(overrides.latitude ?? location.geo?.latitude, 90)
  const longitude = finite(overrides.longitude ?? location.geo?.longitude, 180)
  const coordinates = latitude !== null && longitude !== null
  const city = clean(overrides.city ?? address.addressLocality ?? '')
  const venueAddress = clean(overrides.address ?? address.streetAddress ?? venueName)
  const venue = missingVenue ? null : { name: venueName, address: venueAddress, city: city || null,
    latitude: coordinates ? latitude : null, longitude: coordinates ? longitude : null }
  if (!venue) warnings.push('Venue unannounced')
  const org = raw.organizer?.[0] ?? raw.organizer
  const organizer = overrides.organizer === null ? null : clean(overrides.organizer ?? org?.name ?? '') || null
  const organizerUrl = safeUrl(org?.url ?? org?.sameAs?.[0])
  const offer = Array.isArray(raw.offers) ? raw.offers[0] : (raw.offers ?? {})
  const isFree = overrides.is_free ?? raw.isAccessibleForFree === true
  // Do not coerce null or an empty price to zero; paid/unknown stays unknown.
  const price = overrides.price ?? offer.lowPrice ?? offer.price
  const paisa = price !== null && price !== undefined && price !== '' && /^\d+(\.\d{1,2})?$/.test(String(price))
    ? Math.round(Number(price) * 100) : null
  const offerUrl = safeUrl(overrides.offer_url ?? offer.url)
  const image = Array.isArray(raw.image) ? raw.image[0] : raw.image
  const cover = safeUrl(overrides.cover_image_url ?? (typeof image === 'object' ? image.url : image))
  let category_id = overrides.category_id ?? categoryMap[raw.category] ?? 'cat_community'
  if (!overrides.category_id && /stand.?up|comedy/i.test(title)) category_id = 'cat_comedy'
  if (!overrides.category_id && /\b(?:live|concert|blues)\b/i.test(title) && raw.category === 'Tech & Business') category_id = 'cat_concert'
  const ownStatus = /EventPostponed|EventCancelled/.test(raw.eventStatus ?? '')
  if (ownStatus) warnings.push(`Source status: ${raw.eventStatus}`)
  if (!cover) warnings.push('No public event poster')
  if (title.length > 200) warnings.push('Title exceeds NepScene limit')
  const description = [clean(overrides.description ?? raw.description ?? ''), ...notes,
    `Source: ${url}`, ownStatus ? `Source status: ${raw.eventStatus}` : ''].filter(Boolean).join('\n\n')
  if (description.length > 20000) warnings.push('Description exceeds NepScene limit')
  const key = `katajaam:${id}`
  const fingerprint = 'katajaam:' + hash(`${titleKey(title)}|${starts_at ?? ('unknown:'+id)}|${normal(venueName.split(',')[0])}|${normal(city)}`)
  return { id: `kj_${hash(key)}`, source_id: key, fingerprint, url, title, description,
    starts_at, ends_at, timezone: 'Asia/Kathmandu', venue, organizer, organizer_url: organizerUrl,
    category_id, cover_image_url: cover, listing_type: isFree ? 'free' : offerUrl ? 'ticketed_external' : 'announcement',
    offer_url: isFree ? null : offerUrl, offer_price_from_paisa: isFree ? null : paisa,
    offer_currency: clean(overrides.currency ?? offer.priceCurrency ?? 'NPR'),
    offer_sold_out: /SoldOut/.test(offer.availability ?? '') ? 1 : 0,
    status: publish && !warnings.length ? 'published' : 'draft', warnings, now,
    snapshot_hash: hash(JSON.stringify(raw)) }
}
const distance = (a, b) => Math.hypot((a.latitude - b.latitude)*111000, (a.longitude - b.longitude)*98000)
export function sameEvent(a, b) {
  if (!a.starts_at || !b.starts_at || instant(a.starts_at) !== instant(b.starts_at) || titleKey(a.title) !== titleKey(b.title)) return false
  const av = a.venue, bv = b.venue
  if (!av || !bv) return false
  if ([av.latitude, av.longitude, bv.latitude, bv.longitude].every((n) => typeof n === 'number')) return distance(av, bv) <= 120
  return normal(av.name) === normal(bv.name) && normal(av.city) === normal(bv.city)
}
export function plan(events, existing = [], sources = []) {
  const known = [...existing], result = []
  const aliases = new Map(sources.map((s) => [s.source_id, s.listing_id]))
  for (const e of events) {
    if (e.skip) { result.push({ ...e, action: 'excluded' }); continue }
    const sourceMatch = known.find((x) => x.id === aliases.get(e.source_id) || x.import_source_id === e.source_id || x.url === e.url)
    const match = sourceMatch ?? known.find((x) => x.fingerprint === e.fingerprint || sameEvent(e, x))
    if (match) {
      const changed = Boolean(sourceMatch && (match.title !== e.title || instant(match.starts_at) !== e.starts_at))
      result.push({ ...e, action: 'duplicate', listing_id: match.id, changed, reason: sourceMatch ? 'source already imported' : 'same event, time and venue' })
      aliases.set(e.source_id, match.id)
    } else {
      result.push({ ...e, action: 'insert', listing_id: e.id })
      known.push({ ...e, import_source_id: e.source_id })
      aliases.set(e.source_id, e.id)
    }
  }
  return result
}
export const sqlValue = (v) => v === null || v === undefined ? 'NULL' : typeof v === 'number'
  ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/\0/g, '').replace(/'/g, "''")}'`
const values = (xs) => xs.map(sqlValue).join(', ')
export function buildSql(items, existingVenues = [], existingOrgs = []) {
  const statements = [], venues = [...existingVenues], orgs = [...existingOrgs]
  for (const e of items.filter((x) => x.action !== 'excluded')) {
    const q = sqlValue, canonical = `(SELECT id FROM listings WHERE import_source_id=${q(e.source_id)} OR import_fingerprint=${q(e.fingerprint)} OR id=${q(e.listing_id)} ORDER BY id LIMIT 1)`
    if (e.action === 'insert') {
      let venueId = null, orgId = null
      if (e.venue) {
        const v = e.venue
        const found = venues.find((x) => normal(x.name) === normal(v.name) && normal(x.city) === normal(v.city))
        venueId = found?.id ?? `kjv_${hash(normal(v.name)+'|'+normal(v.city))}`
        if (!found) {
          statements.push(`INSERT INTO venues (id,slug,name,address,city,latitude,longitude,created_at,updated_at) VALUES (${values([venueId,slug(v.name)+'-'+hash(venueId).slice(0,8),v.name,v.address,v.city,v.latitude,v.longitude,e.now,e.now])}) ON CONFLICT(id) DO NOTHING;`)
          venues.push({ ...v, id: venueId })
        }
      }
      if (e.organizer) {
        const found = orgs.find((x) => normal(x.name) === normal(e.organizer))
        orgId = found?.id ?? `kjo_${hash(normal(e.organizer))}`
        if (!found) {
          statements.push(`INSERT INTO organizations (id,slug,name,website_url,created_at,updated_at) VALUES (${values([orgId,slug(e.organizer)+'-'+hash(orgId).slice(0,8),e.organizer,e.organizer_url,e.now,e.now])}) ON CONFLICT(id) DO NOTHING;`)
          orgs.push({ id: orgId, name: e.organizer })
        }
      }
      const columns = 'id,slug,title,description,listing_type,source,status,organization_id,venue_id,starts_at,ends_at,timezone,cover_image_url,external_url,offer_url,offer_provider,offer_price_from_paisa,offer_currency,offer_sold_out,offer_checked_at,location_lat,location_lng,published_at,created_at,updated_at,import_source_id,import_fingerprint'
      statements.push(`INSERT INTO listings (${columns}) SELECT ${values([e.id,slug(e.title)+'-'+hash(e.id).slice(0,8),e.title,e.description,e.listing_type,'import',e.status,orgId,venueId,e.starts_at,e.ends_at,e.timezone,e.cover_image_url,e.url,e.offer_url,e.offer_url?'external':null,e.offer_price_from_paisa,e.offer_currency,e.offer_sold_out,e.now,e.venue?.latitude,e.venue?.longitude,e.status==='published'?e.now:null,e.now,e.now,e.source_id,e.fingerprint])} WHERE NOT EXISTS (SELECT 1 FROM import_sources WHERE source_id=${q(e.source_id)}) ON CONFLICT DO NOTHING;`)
      // Guard child inserts as well: a repeated or interrupted SQL file is harmless.
      statements.push(`INSERT INTO listing_categories (listing_id,category_id,is_primary) SELECT id,${q(e.category_id)},1 FROM listings WHERE id=${q(e.id)} AND import_source_id=${q(e.source_id)} AND NOT EXISTS (SELECT 1 FROM listing_categories WHERE listing_id=${q(e.id)}) ON CONFLICT DO NOTHING;`)
      statements.push(`INSERT INTO audit_log (id,entity_type,entity_id,action,actor_role,details,created_at) SELECT ${q('kja_'+hash(e.id))},'listing',id,'imported','importer',${q(JSON.stringify({source:e.url,status:e.status,warnings:e.warnings}))},${q(e.now)} FROM listings WHERE id=${q(e.id)} ON CONFLICT(id) DO NOTHING;`)
    }
    statements.push(`INSERT INTO import_sources (source_id,listing_id,source_url,first_seen_at) SELECT ${q(e.source_id)},id,${q(e.url)},${q(e.now)} FROM listings WHERE id=${canonical} ON CONFLICT(source_id) DO NOTHING;`)
  }
  return statements.join('\n') + '\n'
}
