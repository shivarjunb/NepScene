import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScrapers } from '../scrape-all.mjs'

test('all sources run after a failure, with scrape-only imports and a failed summary', () => {
 const output = mkdtempSync(join(tmpdir(), 'nepscene-scrapers-'))
 try {
  const calls = []
  const report = runScrapers({ output, execute: (node, args, options) => {
   calls.push({ args, options })
   return calls.length === 1 ? { status: null, error: Error('timeout') } : { status: 0 }
  } })
  assert.equal(calls.length, 4)
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
