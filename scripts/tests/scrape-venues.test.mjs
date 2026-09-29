import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../scrape-venues.mjs'

const { Response } = globalThis

const page = `<html><body><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Event', name: 'Discussion at Martin Chautari',
  startDate: '2099-10-01T15:00:00+05:45', url: 'https://martinchautari.org.np/events/discussion',
  location: { '@type': 'Place', name: 'Martin Chautari', address: 'Kathmandu' },
})}</script></body></html>`

async function run(sources, { up }) {
  const out = mkdtempSync(join(tmpdir(), 'nepscene-venues-'))
  const realFetch = globalThis.fetch, exitCode = process.exitCode
  globalThis.fetch = async (url) => up(new URL(url).hostname) ? new Response(page, { status: 200 }) : new Response('gone', { status: 404 })
  try {
    await main(['--scrape-only', '--out', out, '--source', sources, '--max-pages', '2'])
    return { exitCode: process.exitCode, inventory: JSON.parse(readFileSync(join(out, 'inventory.json'), 'utf8')) }
  } finally {
    globalThis.fetch = realFetch; process.exitCode = exitCode
    rmSync(out, { recursive: true, force: true })
  }
}

test('one failing venue site is recorded in the inventory without failing the scrape', async () => {
  const { exitCode, inventory } = await run('ktm-026,ktm-154', { up: host => host.includes('martinchautari') })
  assert.equal(exitCode ?? 0, 0)
  assert.equal(inventory.complete, false)
  assert.deepEqual(inventory.failed_sources.map(f => [f.id, f.status]), [['ktm-154', 'failed']])
  assert.ok(inventory.events.some(e => e.source_id === 'ktm-026'), 'the working source’s events are kept')
})

test('the scrape fails only when every selected source fell short', async () => {
  const { exitCode, inventory } = await run('ktm-026,ktm-154', { up: () => false })
  assert.equal(exitCode, 1)
  assert.equal(inventory.failed_sources.length, 2)
})
