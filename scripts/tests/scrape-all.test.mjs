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
  assert.equal(JSON.parse(readFileSync(join(output, 'summary.json'))).complete, false)
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
  // Five scrapes, then only the taragaon import ran; the katajaam import was skipped, not attempted.
  assert.equal(calls.length, 6)
  assert.equal(report.apply, 'production')
  assert.deepEqual(report.jobs.map(j => j.name), ['ticketsanjal', 'khalti', 'katajaam', 'taragaon', 'venues', 'katajaam-import', 'taragaon-import'])
  const katajaamImport = report.jobs.find(j => j.name === 'katajaam-import')
  assert.equal(katajaamImport.skipped, true)
  assert.equal(katajaamImport.success, false)
  assert.match(katajaamImport.error, /katajaam did not succeed/)
  const taragaonImport = report.jobs.find(j => j.name === 'taragaon-import')
  assert.equal(taragaonImport.success, true)
  assert.deepEqual(taragaonImport.import, { new_drafts: 4, duplicates: 2 })
  const applyCall = calls.at(-1).args
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
