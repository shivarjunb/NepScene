import { readFileSync } from 'node:fs'

const core = JSON.parse(readFileSync(new URL('../scrape-sources.json', import.meta.url), 'utf8'))
const venues = JSON.parse(readFileSync(new URL('../venue-sources.json', import.meta.url), 'utf8')).filter(source => source.enabled)
export const sourceIds = [...core, ...venues].map(source => source.id)
export const venueIds = venues.map(source => source.id)

export function validateSources(sources) {
  if (!Array.isArray(sources) || sources.some(id => typeof id !== 'string' || !sourceIds.includes(id)) || new Set(sources).size !== sources.length) {
    throw Error('Source selection must be an array of distinct supported source IDs')
  }
  return sources
}
