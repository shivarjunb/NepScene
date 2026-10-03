import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSources } from '../scrape-settings.mjs'

const env = { NEPSCENE_API_URL: 'https://nepscene.test/', SCRAPE_REPORT_TOKEN: 'token' }

test('manual runs retain their captured selection, including all off', async () => {
 for (const sources of [['ktm-026'], []]) {
  assert.deepEqual(await loadSources({ env: { SCRAPE_SOURCES: JSON.stringify(sources) }, fetcher: () => { throw Error('must not fetch') } }), sources)
 }
})

test('scheduled runs load saved settings through the authenticated API', async () => {
 const result = await loadSources({ env, fetcher: async (url, init) => {
  assert.equal(url, 'https://nepscene.test/api/internal/scrape-sources')
  assert.equal(init.headers.authorization, 'Bearer token')
  return globalThis.Response.json(['khalti', 'ktm-026'])
 } })
 assert.deepEqual(result, ['khalti', 'ktm-026'])
})

test('settings failures never fall back to running all sources', async () => {
 await assert.rejects(loadSources({ env: {} }), /require/)
 await assert.rejects(loadSources({ env, fetcher: async () => new globalThis.Response('', { status: 503 }) }), /HTTP 503/)
 for (const data of [null, {}, ['unknown'], ['ktm-026', 'ktm-026']]) {
  await assert.rejects(loadSources({ env: { SCRAPE_SOURCES: JSON.stringify(data) } }), /supported source IDs/)
 }
})
