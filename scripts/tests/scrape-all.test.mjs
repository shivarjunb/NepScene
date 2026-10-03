import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { options, runScrapers } from '../scrape-all.mjs'

test('all sources run after a failure, with scrape-only imports and a failed summary', () => {
 const output = mkdtempSync(join(tmpdir(), 'nepscene-scrapers-'))
 try {
  const calls = []
  const report = runScrapers({ output, execute: (node, args, options) => {
   calls.push({ args, options })
   return calls.length === 1 ? { status: null, error: Error('timeout') } : { status: 0 }
  } })
  assert.equal(calls.length, 5)
  assert.equal(report.complete, false)
  assert.equal(report.jobs[0].error, 'timeout')
  assert.ok(report.jobs.slice(1).every(job => job.success))
  for (const call of calls.slice(2)) {
   assert.ok(call.args.includes('--scrape-only'))
   assert.ok(!call.args.includes('--apply'))
  }
  assert.equal(report.ok, true, 'one failed scraper does not fail the run')
  assert.equal(JSON.parse(readFileSync(join(output, 'summary.json'))).complete, false)
 } finally { rmSync(output, { recursive: true, force: true }) }
})

test('venue sources that fall short are carried on the venues job, and the venue import still runs', () => {
 const output = mkdtempSync(join(tmpdir(), 'nepscene-short-venues-'))
 try {
  const calls = []
  const report = runScrapers({ output, apply: 'production', execute: (node, args, config) => {
   calls.push(args)
   if (args[0].endsWith('scrape-venues.mjs')) writeFileSync(join(config.cwd, 'inventory.json'), JSON.stringify({
    complete: false, events: [], failed_sources: [{ id: 'ktm-154', name: 'Trailmandu Nepal', status: 'partial', errors: ['Expected event markup missing', 'second'] }],
   }))
   return { status: 0 }
  } })
  const venues = report.jobs.find(j => j.name === 'venues')
  assert.equal(venues.success, true)
  assert.deepEqual(venues.failed_sources, [{ id: 'ktm-154', name: 'Trailmandu Nepal', status: 'partial', error: 'Expected event markup missing' }])
  assert.equal(report.jobs.find(j => j.name === 'venues-import').success, true)
  assert.ok(calls.some(args => args[0].endsWith('import-venues.mjs')))
  assert.equal(report.complete, false, 'a short source keeps the run from being complete')
  assert.equal(report.ok, true)
 } finally { rmSync(output, { recursive: true, force: true }) }
})

test('a run in which nothing succeeded is not ok', () => {
 const output = mkdtempSync(join(tmpdir(), 'nepscene-all-failed-'))
 try {
  const report = runScrapers({ output, apply: 'staging', execute: () => ({ status: 1 }) })
  assert.equal(report.ok, false)
  assert.ok(report.jobs.filter(j => j.name.endsWith('-import')).every(j => j.skipped))
 } finally { rmSync(output, { recursive: true, force: true }) }
})

test('--apply adds draft-only imports that read the saved inventories, and skips one whose scrape failed', () => {
 const output = mkdtempSync(join(tmpdir(), 'nepscene-scrapers-'))
 try {
  const calls = []
  const report = runScrapers({ output, apply: 'production', execute: (node, args, options) => {
   calls.push({ args, options })
   // The katajaam scrape (third job) fails; everything else succeeds.
   if (calls.length === 3) return { status: 1 }
   if (args.some(a => a.endsWith('import-taragaon.mjs')) && args.includes('--apply')) {
    writeFileSync(join(options.cwd, 'report.json'), JSON.stringify({ summary: { new_drafts: 4, duplicates: 2 } }))
   }
   return { status: 0 }
  } })
  // Five scrapes, then the taragaon and venue imports ran; the katajaam import was skipped, not attempted.
  assert.equal(calls.length, 7)
  assert.equal(report.apply, 'production')
  assert.deepEqual(report.jobs.map(j => j.name), ['ticketsanjal', 'khalti', 'katajaam', 'taragaon', 'venues', 'katajaam-import', 'taragaon-import', 'venues-import'])
  const katajaamImport = report.jobs.find(j => j.name === 'katajaam-import')
  assert.equal(katajaamImport.skipped, true)
  assert.equal(katajaamImport.success, false)
  assert.match(katajaamImport.error, /katajaam did not succeed/)
  const taragaonImport = report.jobs.find(j => j.name === 'taragaon-import')
  assert.equal(taragaonImport.success, true)
  assert.deepEqual(taragaonImport.import, { new_drafts: 4, duplicates: 2 })
  const applyCall = calls.find(c => c.args.some(a => a.endsWith('import-taragaon.mjs')) && c.args.includes('--apply')).args
  assert.ok(applyCall.includes('--apply'))
  assert.ok(!applyCall.includes('--publish'), 'imports must never publish')
  assert.equal(applyCall[applyCall.indexOf('--env') + 1], 'production')
  assert.equal(applyCall[applyCall.indexOf('--input') + 1], join(output, 'taragaon', 'inventory.json'))
  assert.equal(report.complete, false)
 } finally { rmSync(output, { recursive: true, force: true }) }
})

test('refuses an unknown --apply target before anything runs', () => {
 assert.throws(() => runScrapers({ output: join(tmpdir(), 'never-created'), apply: 'prod', execute: () => { throw Error('must not run') } }), /--apply must be one of/)
 assert.throws(() => options(['--apply']), /Missing value/)
 assert.deepEqual(options(['--apply', 'staging']), { apply: 'staging' })
 assert.deepEqual(options([]), { apply: null })
})

test('venue import uses the saved inventory and reports draft counts; a failed venue scrape skips it', () => {
 for (const failed of [false, true]) {
  const output = mkdtempSync(join(tmpdir(), 'nepscene-venue-runner-'))
  try {
   const calls = []
   const report = runScrapers({ output, apply: 'staging', execute: (node, args, config) => {
    calls.push(args)
    if (args[0].endsWith('scrape-venues.mjs') && failed) return { status: 1 }
    if (args[0].endsWith('import-venues.mjs')) {
     assert.equal(args[args.indexOf('--input') + 1], join(output, 'venues', 'inventory.json'))
     assert.equal(args[args.indexOf('--env') + 1], 'staging')
     assert.ok(args.includes('--apply'))
     assert.ok(!args.includes('--publish'))
     writeFileSync(join(config.cwd, 'report.json'), JSON.stringify({ summary: { new_drafts: 3 } }))
    }
    return { status: 0 }
   } })
   const job = report.jobs.find(j => j.name === 'venues-import')
   assert.equal(job.success, !failed)
   if (failed) {
    assert.equal(job.skipped, true)
    assert.ok(!calls.some(args => args[0].endsWith('import-venues.mjs')))
   } else assert.equal(job.import.new_drafts, 3)
  } finally { rmSync(output, { recursive: true, force: true }) }
 }
})

test('source switches select individual venues and omit disabled scrapers and imports', () => {
 for (const sources of [['ktm-026', 'khalti'], ['katajaam'], []]) {
  const output = mkdtempSync(join(tmpdir(), 'nepscene-selection-'))
  try {
   const calls = []
   const report = runScrapers({ output, sources, apply: 'staging', execute: (node, args) => {
    calls.push(args); return { status: 0 }
   } })
   assert.equal(report.complete, true)
   assert.deepEqual(report.sources, sources)
   if (sources.includes('ktm-026')) {
    assert.deepEqual(report.jobs.map(j => j.name), ['khalti', 'venues', 'venues-import'])
    const venue = calls.find(args => args[0].endsWith('scrape-venues.mjs'))
    assert.equal(venue[venue.indexOf('--source') + 1], 'ktm-026')
   } else if (sources.length) assert.deepEqual(report.jobs.map(j => j.name), ['katajaam', 'katajaam-import'])
   else assert.equal(calls.length, 0)
  } finally { rmSync(output, { recursive: true, force: true }) }
 }
 assert.throws(() => runScrapers({ sources: ['unknown'] }), /supported source IDs/)
})
