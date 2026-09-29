#!/usr/bin/env node
/**
 * The runner's half of the scrape-run ledger (`scrape_runs`, migration 0015).
 *
 * The daily scrape runs on a machine GitHub does not host, and artifact
 * uploads are refused whenever the account's billing is locked — so results
 * go to the site's own API instead: a row in D1 that the admin console shows,
 * and the output tarball in R2. Two commands, one for each end of a run:
 *
 *   scrape-report.mjs start  [--run-id ID] --github-run-id N [--apply ENV]
 *   scrape-report.mjs finish --run-id ID --output DIR [--archive FILE]
 *
 * `start` without `--run-id` is the scheduled run registering itself; with
 * one, it is a run the admin console already created when it pressed the
 * button, now reporting that it has begun. The API's address and the shared
 * token come from NEPSCENE_API_URL and SCRAPE_REPORT_TOKEN — an environment
 * variable, not an argument, because arguments are visible in `ps`.
 */
import { readFileSync, appendFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function options(args) {
  const o = { command: args[0], runId: null, githubRunId: null, apply: null, output: null, archive: null }
  if (!['start', 'finish'].includes(o.command)) throw Error('Usage: scrape-report.mjs start|finish …')
  for (let i = 1; i < args.length; i++) {
    const a = args[i], value = args[i + 1]
    if (!['--run-id', '--github-run-id', '--apply', '--output', '--archive'].includes(a)) throw Error(`Unknown option: ${a}`)
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${a}`)
    o[{ '--run-id': 'runId', '--github-run-id': 'githubRunId', '--apply': 'apply', '--output': 'output', '--archive': 'archive' }[a]] = value
    i++
  }
  if (o.command === 'finish' && (!o.runId || !o.output)) throw Error('finish needs --run-id and --output')
  if (o.command === 'start' && !o.githubRunId) throw Error('start needs --github-run-id')
  return o
}

export async function report(o, { env = process.env, fetch = globalThis.fetch, readFile = readFileSync, fileSize = (f) => statSync(f).size } = {}) {
  const base = env.NEPSCENE_API_URL?.replace(/\/$/, '')
  const token = env.SCRAPE_REPORT_TOKEN
  if (!base || !token) throw Error('NEPSCENE_API_URL and SCRAPE_REPORT_TOKEN must both be set')
  const call = async (method, path, body, type = 'application/json') => {
    const response = await fetch(`${base}/api/internal/scrape-runs${path}`, {
      method, body, headers: { authorization: `Bearer ${token}`, 'content-type': type },
    })
    if (!response.ok) throw Error(`${method} ${path} → HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    return response.json()
  }
  const json = (value) => JSON.stringify(value)

  if (o.command === 'start') {
    const githubRunId = Number(o.githubRunId)
    const run = o.runId
      ? await call('PATCH', `/${encodeURIComponent(o.runId)}`, json({ status: 'running', github_run_id: githubRunId }))
      : await call('POST', '', json({ trigger: 'schedule', github_run_id: githubRunId, apply_env: o.apply }))
    return { id: run.id }
  }

  // finish: the tarball first, so a run whose summary upload fails still has
  // its output; then the verdict, taken from the summary the runner wrote.
  let summary = null, error = null
  try { summary = JSON.parse(readFile(join(o.output, 'summary.json'), 'utf8')) } catch (e) { error = `No summary.json: ${e.message}` }
  let output = null
  if (o.archive) {
    const size = fileSize(o.archive)
    if (size > MAX_ARCHIVE_BYTES) error = [error, `Output archive is ${size} bytes; the limit is ${MAX_ARCHIVE_BYTES}`].filter(Boolean).join('; ')
    else output = await call('PUT', `/${encodeURIComponent(o.runId)}/output`, readFile(o.archive), 'application/gzip')
  }
  const status = summary?.complete ? 'succeeded' : 'failed'
  if (summary && !summary.complete && !error) error = `${summary.jobs.filter(j => !j.success).map(j => j.name).join(', ')} failed`
  const run = await call('PATCH', `/${encodeURIComponent(o.runId)}`, json({ status, summary, error }))
  return { id: run.id, status, output_key: output?.output_key ?? null }
}

/** Matches the API's cap; a scrape's output is a few megabytes of JSON and logs. */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const o = options(process.argv.slice(2))
  const result = await report(o)
  console.log(JSON.stringify(result))
  // So the workflow's later steps can read the id: `steps.<id>.outputs.run_id`.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${result.id}\n`)
}
