import type { Env } from '../env'
import core from '../../scripts/scrape-sources.json'
import venues from '../../scripts/venue-sources.json'

export const SCRAPE_SOURCES = [
  ...core,
  ...venues.filter(source => source.enabled).map(({ id, name }) => ({ id, name })),
]

export async function scrapeSources(env: Env) {
  const { results } = await env.DB.prepare('SELECT source_id, enabled FROM scrape_source_settings')
    .all<{ source_id: string; enabled: number }>()
  const settings = new Map(results.map(row => [row.source_id, row.enabled === 1]))
  return SCRAPE_SOURCES.map(source => ({ ...source, enabled: settings.get(source.id) ?? true }))
}
