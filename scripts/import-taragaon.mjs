#!/usr/bin/env node
/* global AbortSignal */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { crawl, transform, plan, buildSql, ORIGIN } from './lib/taragaon.mjs'

export function options(args) {
  const o = { env: null, apply: false, publish: false, scrapeOnly: false, repo: process.cwd(), out: null, input: null, overrides: null }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--apply') o.apply = true
    else if (a === '--publish') o.publish = true
    else if (a === '--dry-run') { /* Dry run is already the default. */ }
    else if (a === '--scrape-only') o.scrapeOnly = true
    else if (['--env','--repo','--out','--input','--overrides'].includes(a)) {
      if (!args[i+1] || args[i+1].startsWith('--')) throw Error(`Missing value for ${a}`)
      o[a.slice(2)] = args[++i]
    } else if (a === '--help') o.help = true
    else throw Error(`Unknown option: ${a}`)
  }
  if (o.env && !['preview','staging','production'].includes(o.env)) throw Error('--env must be preview, staging, or production')
  if (o.apply && (o.scrapeOnly || args.includes('--dry-run'))) throw Error('--apply cannot be combined with --dry-run or --scrape-only')
  return o
}

async function readPublic(url) {
  if (new URL(url).origin !== ORIGIN) throw Error('Only public Taragaon Next pages may be fetched')
  for (let attempt = 0; attempt < 3; attempt++) {
    // Redirects are refused rather than silently fetching another destination.
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'NepScene-Taragaon-Importer/1.0', Accept: 'text/html,application/xml' } })
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await delay(1000 * 2**attempt); continue
    }
    if (!response.ok) throw Error(`Taragaon Next returned HTTP ${response.status} for ${url}`)
    const body = await response.text()
    if (body.length > 10_000_000) throw Error(`Unexpectedly large source page: ${url}`)
    return body
  }
  throw Error(`Could not read ${url}`)
}
function database(o) {
  const require = createRequire(join(resolve(o.repo), 'package.json'))
  let wrangler
  try {
    const manifest = require.resolve('wrangler/package.json')
    wrangler = resolve(dirname(manifest), require(manifest).bin.wrangler)
  } catch {
    throw Error('Run npm install in NepScene first (or set --repo to its directory).')
  }
  const target = o.env ? ['DB','--env',o.env,'--remote'] : ['nepscene-local','--local']
  const run = (extra) => {
    let output
    try {
      output = execFileSync(process.execPath, [wrangler,'d1','execute',...target,...extra,'--json'], {
        cwd: resolve(o.repo), encoding: 'utf8', maxBuffer: 64*1024*1024,
        env: { ...process.env, CI: 'true' }, stdio: ['ignore','pipe','pipe'],
      })
    } catch (error) {
      const details = [error.stderr, error.stdout].filter(Boolean).map(String).join('\n').trim()
      throw Error(`Wrangler failed (exit ${error.status ?? 'unknown'}).\n${details || error.message}`, { cause: error })
    }
    // Wrangler --json is structured output; do not accept a failed statement.
    const result = JSON.parse(output.trim())
    if (!Array.isArray(result) || result.some((x) => x.success === false || x.error)) throw Error('D1 reported an unsuccessful statement')
    return result.flatMap((x) => x.results ?? [])
  }
  return { query: (sql) => run(['--command',sql]), apply: (file) => run(['--file',file]) }
}

export async function main(args = process.argv.slice(2)) {
  const o = options(args)
  if (o.help) {
    console.log(`Taragaon Next → NepScene (Node 22+; run inside NepScene)
  node scripts/import-taragaon.mjs --scrape-only
  node scripts/import-taragaon.mjs --env production --dry-run
  node scripts/import-taragaon.mjs --env production --apply
  node scripts/import-taragaon.mjs --env production --apply --publish

Default: preview only; local D1 unless --env is supplied. --apply inserts drafts.
--publish publishes only complete new events; uncertain events remain drafts.
--input FILE uses a saved inventory. --overrides FILE supplies reviewed corrections.
--repo DIR chooses the NepScene checkout. --out DIR chooses the report directory.
Existing listings are never overwritten, republished, or deleted.`)
    return
  }
  const dir = resolve(o.out ?? join(o.repo,'.taragaon-imports',new Date().toISOString().replace(/[:.]/g,'-')))
  mkdirSync(dir,{recursive:true})
  console.log(`Reading ${o.input ? 'saved inventory' : 'live Taragaon Next events'}…`)
  const inventory = o.input ? JSON.parse(readFileSync(o.input,'utf8')) : await crawl(readPublic)
  if (!Array.isArray(inventory.events) || !inventory.events.length) throw Error('Inventory has no events')
  writeFileSync(join(dir,'inventory.json'),JSON.stringify(inventory,null,2))
  const overrides = o.overrides ? JSON.parse(readFileSync(o.overrides,'utf8')) : {}
  const now = new Date().toISOString()
  const candidates = inventory.events.map((e) => transform(e,overrides[e.url?.split('/').at(-1)] ?? {},o.publish,now))
  if (o.scrapeOnly) {
    const result = plan(candidates)
    writeFileSync(join(dir,'report.json'),JSON.stringify({mode:'scrape-only',checked_against_database:false,events:result},null,2))
    console.log(`Saved ${inventory.events.length} source entries to ${dir}. No database accessed.`)
    return
  }
  const db = database(o)
  const columns = db.query('PRAGMA table_info(listings)').map((x) => x.name)
  if (!columns.includes('import_source_id') || !columns.includes('import_fingerprint')) throw Error('Apply migrations through 0009_katajaam_import.sql to this database first; see README.md.')
  const existing = db.query(`SELECT l.id,l.title,l.starts_at,l.external_url AS url,l.import_source_id,l.import_fingerprint AS fingerprint,
    v.name AS venue_name,v.city,COALESCE(l.location_lat,v.latitude) AS latitude,COALESCE(l.location_lng,v.longitude) AS longitude
    FROM listings l LEFT JOIN venues v ON v.id=l.venue_id`).map((r) => ({...r,venue:r.venue_name?{name:r.venue_name,city:r.city,latitude:r.latitude,longitude:r.longitude}:null}))
  const sources = db.query('SELECT source_id,listing_id FROM import_sources')
  const venues = db.query('SELECT id,name,city,latitude,longitude FROM venues')
  const orgs = db.query('SELECT id,name FROM organizations')
  const categories = new Set(db.query('SELECT id FROM categories WHERE is_active=1').map((x) => x.id))
  for (const e of candidates) if (!e.skip && !categories.has(e.category_id)) throw Error(`Missing/inactive category: ${e.category_id}`)
  const result = plan(candidates,existing,sources)
  const summary = { source_entries:inventory.events.length, new_drafts:0,new_published:0,duplicates:0,excluded:0,changed_duplicates:0 }
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
  console.log(`Verified ${report.resolved.length} source entries in ${o.env??'local'} D1. Existing listings were preserved.`)
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode=1 })
}

