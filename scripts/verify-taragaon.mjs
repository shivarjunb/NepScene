#!/usr/bin/env node
// Read-only database test for the seven September 2026 Taragaon imports.
// Local: node scripts/verify-taragaon.mjs
// Remote: node scripts/verify-taragaon.mjs --env production
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const expected = [
  ['heritage-walk-to-chabahi-with-saurav-thapa-shrestha', false],
  ['reading-circle-stolen-heritage-and-identities', true],
  ['shabdakiri-saajh-28-poetry-and-gazal', true],
  ['resident-artist-open-studio-and-mini-paper-weaving-workshop-with-amisha-maharjan', true],
  ['film-screening-have-you-seen-my-gods', true],
  ['film-screening-shiva-linga-a-visual-journey', true],
  ['doodling-at-taragaon-4', false],
]

export function failures(rows) {
  const errors = []
  for (const [slug, fallback] of expected) {
    const source = `taragaon:${slug}`
    const matches = rows.filter(r => r.source_id === source)
    const fail = message => errors.push(`${source}: ${message}`)
    if (matches.length !== 1 || !matches[0].id) {
      fail(`expected exactly one linked listing, found ${matches.filter(r => r.id).length}`)
      continue
    }
    const r = matches[0]
    if (r.import_source_id !== source) fail('listing source identity does not match')
    if (r.status !== 'published') fail(`status is ${r.status}, expected published`)
    if (!r.published_at || Number.isNaN(Date.parse(r.published_at))) fail('missing valid published_at')
    if (!r.starts_at || Number.isNaN(Date.parse(r.starts_at))) fail('missing valid starts_at')
    if (!r.title || !r.slug) fail('missing title or public slug')
    if (!r.venue_name) fail('missing venue')
    if (!r.active_category) fail('missing active category')
    if (fallback && (r.venue_name !== 'Taragaon Next' || r.city !== 'Boudha')) {
      fail(`venue is ${r.venue_name} / ${r.city}, expected Taragaon Next / Boudha`)
    }
  }
  return errors
}

export function main(args = process.argv.slice(2)) {
  let env = null
  let repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') {
      console.log('Usage: node scripts/verify-taragaon.mjs [--env preview|staging|production] [--repo DIR]\nDefault: local D1. SELECT only; never imports or publishes. Exits 1 on any failed check.')
      return
    }
    const option = args[i]
    if (!['--env', '--repo'].includes(option)) throw Error(`Unknown option: ${option}`)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${option}`)
    if (option === '--env') env = value
    else repo = resolve(value)
  }
  if (env && !['preview', 'staging', 'production'].includes(env)) throw Error('Invalid --env')
  const require = createRequire(join(repo, 'package.json'))
  const manifest = require.resolve('wrangler/package.json')
  const wrangler = resolve(dirname(manifest), require(manifest).bin.wrangler)
  const target = env ? ['DB', '--env', env, '--remote'] : ['nepscene-local', '--local']
  // Fixed expected identities, independent of the importer or its reports.
  // LEFT JOINs expose missing sources/listings instead of silently omitting them.
  const sql = `WITH expected(source_id) AS (VALUES ${expected.map(([slug]) => `('taragaon:${slug}')`).join(',')})
    SELECT e.source_id,l.id,l.import_source_id,l.title,l.slug,l.status,l.published_at,l.starts_at,
      v.name AS venue_name,v.city,
      EXISTS(SELECT 1 FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
        WHERE lc.listing_id=l.id AND c.is_active=1) AS active_category
    FROM expected e LEFT JOIN import_sources s ON s.source_id=e.source_id
    LEFT JOIN listings l ON l.id=s.listing_id LEFT JOIN venues v ON v.id=l.venue_id`
  console.log(`Checking ${env ?? 'local'} D1 in ${repo} (read-only)…`)
  let output
  try {
    output = execFileSync(process.execPath, [wrangler, 'd1', 'execute', ...target, '--command', sql, '--json'], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    throw Error(`Wrangler failed: ${String(error.stderr || error.stdout || error.message).trim()}`, { cause: error })
  }
  const result = JSON.parse(output.trim())
  if (!Array.isArray(result) || !result.length || result.some(r => r.success === false || r.error || !Array.isArray(r.results))) {
    throw Error('D1 returned an unsuccessful or malformed query result')
  }
  const rows = result.flatMap(r => r.results)
  const errors = failures(rows)
  if (errors.length) throw Error(`FAIL (${env ?? 'local'}):\n${errors.join('\n')}`)
  for (const r of rows) console.log(`PASS ${r.title} | published | ${r.venue_name} / ${r.city}`)
  console.log(`PASS: all 7 entries exist and are published in ${env ?? 'local'} D1; all 5 fallback venues are Taragaon Next / Boudha.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
