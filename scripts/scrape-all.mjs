#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function runScrapers({ root = repository, output = join(root, 'scrape-output', new Date().toISOString().replace(/[:.]/g, '-')), execute = spawnSync } = {}) {
 mkdirSync(output, { recursive: true })
 const jobs = [
  { name: 'ticketsanjal', script: 'ticketsanjal-scraper/scrape.mjs', args: [] },
  { name: 'khalti', script: 'scripts/scrape-khalti.mjs', args: [join(output, 'khalti')] },
  { name: 'katajaam', script: 'scripts/import-katajaam.mjs', args: ['--scrape-only', '--repo', root, '--out', join(output, 'katajaam')] },
  { name: 'taragaon', script: 'scripts/import-taragaon.mjs', args: ['--scrape-only', '--repo', root, '--out', join(output, 'taragaon')] },
 ]
 const report = { started_at: new Date().toISOString(), complete: false, jobs: [] }
 for (const job of jobs) {
  const cwd = join(output, job.name)
  mkdirSync(cwd, { recursive: true })
  const log = join(cwd, 'run.log')
  const fd = openSync(log, 'w')
  console.log(`Scraping ${job.name}; log: ${log}`)
  let result
  try {
   result = execute(process.execPath, [join(root, job.script), ...job.args], {
    cwd, stdio: ['ignore', fd, fd], timeout: 15 * 60 * 1000, killSignal: 'SIGKILL',
   })
  } catch (error) { result = { status: null, error } }
  finally { closeSync(fd) }
  report.jobs.push({ name: job.name, success: result.status === 0 && !result.error, exit_code: result.status ?? null, signal: result.signal ?? null, error: result.error?.message ?? null, log })
  writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2))
  console.log(`${job.name}: ${report.jobs.at(-1).success ? 'OK' : 'FAILED'}`)
 }
 report.complete = report.jobs.every(job => job.success)
 report.finished_at = new Date().toISOString()
 writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2))
 console.log(`Results: ${output}`)
 return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 if (process.argv.length > 2) throw Error('Usage: node scripts/scrape-all.mjs')
 if (!runScrapers().complete) process.exitCode = 1
}
