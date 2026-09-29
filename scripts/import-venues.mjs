#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { database } from './import-katajaam.mjs'
import { plan, buildSql } from './lib/katajaam.mjs'
import { transform } from './lib/venue-events.mjs'

const registry = JSON.parse(readFileSync(new URL('./venue-sources.json', import.meta.url), 'utf8'))

export function options(args) {
  const o = { env: null, apply: false, repo: process.cwd(), out: null, input: null }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--apply') o.apply = true
    else if (a === '--dry-run') { /* Default: report without writing. */ }
    else if (['--env', '--repo', '--out', '--input'].includes(a)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${a}`)
      o[a.slice(2)] = args[++i]
    } else throw Error(`Unknown option: ${a}`)
  }
  if (!o.input) throw Error('--input is required: use the saved venue inventory')
  if (o.env && !['preview', 'staging', 'production'].includes(o.env)) throw Error('Unknown environment')
  if (o.apply && args.includes('--dry-run')) throw Error('--apply cannot be combined with --dry-run')
  return o
}

export async function main(args = process.argv.slice(2), { connect = database, now = new Date().toISOString() } = {}) {
  const o = options(args)
  const inventory = JSON.parse(readFileSync(o.input, 'utf8'))
  if (!Array.isArray(inventory.events)) throw Error('Venue inventory has no events list; refusing import')
  // A partial inventory is still imported: planning only inserts or matches,
  // so a source that fell short cannot take anything away. An old-format
  // inventory with no record of which sources fell short is still refused.
  if (inventory.complete !== true && !Array.isArray(inventory.failed_sources)) throw Error('Venue inventory is incomplete and does not say which sources failed; refusing import')
  const failedSources = inventory.failed_sources ?? []
  for (const f of failedSources) console.warn(`WARNING ${f.id} ${f.name}: ${f.status} — ${f.errors?.join('; ') || 'no detail'}`)
  const candidates = inventory.events.map(raw => {
    const source = registry.find(s => s.id === raw.source_id && s.enabled)
    if (!source) throw Error(`Unknown or disabled venue source: ${raw.source_id}`)
    if (raw.review_only) return { ...raw, skip: 'Source requires manual review' }
    return transform(raw, source, now)
  })
  const dir = resolve(o.out ?? join(o.repo, 'scrape-output', 'venues-import', now.replace(/[:.]/g, '-')))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify(inventory, null, 2))
  const db = connect(o)
  const columns = db.query('PRAGMA table_info(listings)').map((x) => x.name)
  if (!columns.includes('import_source_id') || !columns.includes('import_fingerprint')) throw Error('Apply migrations through 0012_katajaam_import.sql to this database first; see docs/KATAJAAM_IMPORT.md.')
  const existing = db.query(`SELECT l.id,l.title,l.starts_at,l.external_url AS url,l.import_source_id,l.import_fingerprint AS fingerprint,
    v.name AS venue_name,v.city,COALESCE(l.location_lat,v.latitude) AS latitude,COALESCE(l.location_lng,v.longitude) AS longitude
    FROM listings l LEFT JOIN venues v ON v.id=l.venue_id`).map((r) => ({...r,venue:r.venue_name?{name:r.venue_name,city:r.city,latitude:r.latitude,longitude:r.longitude}:null}))
  const sources = db.query('SELECT source_id,listing_id FROM import_sources')
  const venues = db.query('SELECT id,name,city,latitude,longitude FROM venues')
  const orgs = db.query('SELECT id,name FROM organizations')
  const categories = new Set(db.query('SELECT id FROM categories WHERE is_active=1').map((x) => x.id))
  for (const e of candidates) if (!e.skip && !categories.has(e.category_id)) throw Error(`Missing/inactive category: ${e.category_id}`)
  const result = plan(candidates,existing,sources)
  const summary = { source_entries:inventory.events.length, new_drafts:0,new_published:0,duplicates:0,excluded:0,changed_duplicates:0,failed_sources:failedSources.map((f) => f.id) }
  for (const e of result) {
    if (e.action==='insert') summary[e.status==='published'?'new_published':'new_drafts']++
    else if (e.action==='duplicate') { summary.duplicates++; if(e.changed)summary.changed_duplicates++ }
    else summary.excluded++
  }
  const report = { target:o.env??'local',mode:o.apply?'apply':'dry-run',checked_at:now,summary,events:result }
  writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2))
  const sql = buildSql(result,venues,orgs), file = join(dir,'import.sql')
  writeFileSync(file,sql)
  console.log(JSON.stringify(summary,null,2))
  console.log(`Report: ${join(dir,'report.json')}`)
  if (!o.apply) { console.log('Preview only. Run again with --apply to insert.'); return }
  // Use the query path, not D1's bulk-file import job. Each event is a small
  // batch; a failed run can resume from database identities on the next run.
  const writable = result.filter((e) => e.action !== 'excluded')
  for (let i = 0; i < writable.length; i++) {
    const event = writable[i]
    console.log(`Writing ${i + 1}/${writable.length}: ${event.title}`)
    try {
      db.query(buildSql([event], venues, orgs))
    } catch (error) {
      throw Error(`Stopped at ${event.source_id}. Earlier batches may have completed; rerun safely to resume.\n${error.message}`, { cause: error })
    }
  }
  // Resolve every source, including source aliases, before reporting success.
  const after = new Map(db.query('SELECT source_id,listing_id FROM import_sources').map((r) => [r.source_id,r.listing_id]))
  const missing = result.filter((e) => e.action!=='excluded' && !after.has(e.source_id))
  report.verified = missing.length===0
  report.resolved = result.filter((e) => e.action!=='excluded').map((e) => ({source_id:e.source_id,listing_id:after.get(e.source_id)??null}))
  writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2))
  if (missing.length) throw Error(`Import verification failed for ${missing.length} entries. Inspect report; rerunning is safe.`)
  console.log(`Verified ${report.resolved.length} venue source entries in ${o.env??'local'} D1.`)
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
