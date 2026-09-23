#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const APPLY_ENVIRONMENTS = ['preview', 'staging', 'production']

/**
 * The importers that can write to D1, and the scrape whose saved inventory
 * each one reads. Applying re-uses the inventory the scrape just saved
 * (`--input`) rather than crawling the source a second time — one crawl per
 * run is what the sources see, and what the summary describes.
 */
const IMPORTS = [
 { name: 'katajaam-import', scrape: 'katajaam', script: 'scripts/import-katajaam.mjs' },
 { name: 'taragaon-import', scrape: 'taragaon', script: 'scripts/import-taragaon.mjs' },
]

export function runScrapers({ root = repository, output = join(root, 'scrape-output', new Date().toISOString().replace(/[:.]/g, '-')), execute = spawnSync, apply = null } = {}) {
 if (apply !== null && !APPLY_ENVIRONMENTS.includes(apply)) throw Error(`--apply must be one of ${APPLY_ENVIRONMENTS.join(', ')}`)
 mkdirSync(output, { recursive: true })
 const jobs = [
  // ticketsanjal is temporarily disabled — it needs Playwright's browser
  // binaries, which daily-scrape.yml no longer installs. Re-add both to
  // bring it back.
  // { name: 'ticketsanjal', script: 'ticketsanjal-scraper/scrape.mjs', args: [] },
  { name: 'khalti', script: 'scripts/scrape-khalti.mjs', args: [join(output, 'khalti')] },
  { name: 'katajaam', script: 'scripts/import-katajaam.mjs', args: ['--scrape-only', '--repo', root, '--out', join(output, 'katajaam')] },
  { name: 'taragaon', script: 'scripts/import-taragaon.mjs', args: ['--scrape-only', '--repo', root, '--out', join(output, 'taragaon')] },
  { name: 'venues', script: 'scripts/scrape-venues.mjs', args: ['--scrape-only', '--out', join(output, 'venues')] },
 ]
 // Drafts only: `--publish` is deliberately not offered here. What a scrape
 // found goes into the queue for a person to publish (the moderation queue's
 // "imported" filter), never straight onto the public site.
 if (apply) for (const i of IMPORTS) jobs.push({
  name: i.name, script: i.script, requires: i.scrape,
  args: ['--env', apply, '--apply', '--repo', root, '--input', join(output, i.scrape, 'inventory.json'), '--out', join(output, i.name)],
 })
 const report = { started_at: new Date().toISOString(), apply, complete: false, jobs: [] }
 const save = () => writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2))
 for (const job of jobs) {
  const cwd = join(output, job.name)
  mkdirSync(cwd, { recursive: true })
  const log = join(cwd, 'run.log')
  const entry = { name: job.name, success: false, exit_code: null, signal: null, error: null, log }
  const upstream = job.requires && report.jobs.find(j => j.name === job.requires)
  if (job.requires && !upstream?.success) {
   // An import from a failed scrape would apply a partial inventory as if it
   // were the whole one. Skipped, and said so, rather than attempted.
   entry.skipped = true
   entry.error = `${job.requires} did not succeed, so nothing was imported`
   writeFileSync(log, entry.error + '\n')
   report.jobs.push(entry); save()
   console.log(`${job.name}: SKIPPED (${entry.error})`)
   continue
  }
  const fd = openSync(log, 'w')
  console.log(`Scraping ${job.name}; log: ${log}`)
  let result
  try {
   result = execute(process.execPath, [join(root, job.script), ...job.args], {
    cwd, stdio: ['ignore', fd, fd], timeout: 15 * 60 * 1000, killSignal: 'SIGKILL',
   })
  } catch (error) { result = { status: null, error } }
  finally { closeSync(fd) }
  Object.assign(entry, { success: result.status === 0 && !result.error, exit_code: result.status ?? null, signal: result.signal ?? null, error: result.error?.message ?? null })
  if (job.requires) entry.import = importSummary(join(cwd, 'report.json'))
  report.jobs.push(entry); save()
  console.log(`${job.name}: ${entry.success ? 'OK' : 'FAILED'}`)
 }
 report.complete = report.jobs.every(job => job.success)
 report.finished_at = new Date().toISOString()
 save()
 console.log(`Results: ${output}`)
 return report
}

/** The importer's own count of what it did, or null when it never got that far. */
function importSummary(file) {
 if (!existsSync(file)) return null
 try { return JSON.parse(readFileSync(file, 'utf8')).summary ?? null } catch { return null }
}

export function options(args) {
 const o = { apply: null }
 for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
   if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('Missing value for --apply')
   o.apply = args[++i]
  } else throw Error('Usage: node scripts/scrape-all.mjs [--apply preview|staging|production]')
 }
 return o
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 if (!runScrapers(options(process.argv.slice(2))).complete) process.exitCode = 1
}
