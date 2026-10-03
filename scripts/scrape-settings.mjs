#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateSources } from './lib/scrape-sources.mjs'

// Manual runs carry the selection made when Run now was clicked. Scheduled
// and ad-hoc runs read the saved settings. Failure must never enable sources.
export async function loadSources({ env = process.env, fetcher = fetch } = {}) {
  if (env.SCRAPE_SOURCES) return validateSources(JSON.parse(env.SCRAPE_SOURCES))
  if (!env.NEPSCENE_API_URL || !env.SCRAPE_REPORT_TOKEN) throw Error('Source settings require NEPSCENE_API_URL and SCRAPE_REPORT_TOKEN')
  const response = await fetcher(`${env.NEPSCENE_API_URL.replace(/\/$/, '')}/api/internal/scrape-sources`, {
    headers: { authorization: `Bearer ${env.SCRAPE_REPORT_TOKEN}` },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw Error(`Could not read source settings: HTTP ${response.status}`)
  return validateSources(await response.json())
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: scrape-settings.mjs OUTPUT_FILE')
  writeFileSync(process.argv[2], JSON.stringify(await loadSources()))
}
