import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, options } from '../import-venues.mjs'

const now = '2026-09-01T00:00:00.000Z'
const event = (changes = {}) => ({ source_id: 'ktm-026', name: 'Discussion at Martin Chautari',
  url: 'https://martinchautari.org.np/events/discussion', startDate: '2026-10-01T15:00:00+05:45',
  location: { name: 'Martin Chautari', address: { addressLocality: 'Kathmandu' } }, ...changes })

async function fixture(run) {
  const out = mkdtempSync(join(tmpdir(), 'venue-import-'))
  const db = new DatabaseSync(':memory:')
  try {
    const migrations = new URL('../../migrations/', import.meta.url)
    for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
    db.exec('PRAGMA foreign_keys=ON')
    const connect = () => ({ query: sql => {
      if (/^(SELECT|PRAGMA)\b/.test(sql)) return db.prepare(sql).all()
      db.exec(sql); return []
    } })
    const input = join(out, 'input.json')
    const save = events => writeFileSync(input, JSON.stringify({ complete: true, events }))
    const args = ['--input', input, '--out', out]
    await run({ db, save, args, deps: { connect, now }, out, input })
  } finally { db.close(); rmSync(out, { recursive: true, force: true }) }
}

test('venue imports create drafts with real event links; repeat runs preserve edited listings', async () => {
  await fixture(async ({ db, save, args, deps, out }) => {
    save([event(), event({ name: 'Second discussion', startDate: '2026-10-02T15:00:00+05:45' }),
      event({ name: 'Past discussion', startDate: '2020-01-01' }), event({ name: 'Review this', review_only: true })])
    await main(args, deps)
    assert.equal(db.prepare('SELECT count(*) AS n FROM listings').get().n, 0, 'dry run does not write')
    await main([...args, '--apply'], deps)
    const rows = db.prepare('SELECT status,external_url,source FROM listings').all()
    assert.equal(rows.length, 2, 'two occurrences sharing a URL remain distinct')
    assert.ok(rows.every(r => r.status === 'draft' && r.source === 'import' && r.external_url === event().url))
    db.exec("UPDATE listings SET title='Edited by admin'")
    await main([...args, '--apply'], deps)
    assert.equal(db.prepare('SELECT count(*) AS n FROM listings').get().n, 2)
    assert.ok(db.prepare('SELECT title FROM listings').all().every(r => r.title === 'Edited by admin'))
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
    assert.equal(report.verified, true)
    assert.equal(report.summary.new_drafts, 0)
    assert.equal(report.summary.duplicates, 2)
    assert.equal(report.summary.excluded, 2)
  })
})

test('empty inventories succeed and date-only events remain drafts with unknown times', async () => {
  await fixture(async ({ db, save, args, deps }) => {
    save([])
    await main([...args, '--apply'], deps)
    save([event({ startDate: '2026-10-01' })])
    await main([...args, '--apply'], deps)
    const row = db.prepare('SELECT starts_at,status FROM listings').get()
    assert.equal(row.starts_at, null)
    assert.equal(row.status, 'draft')
  })
})

test('an inventory with sources that fell short imports what the others found and names the short ones', async () => {
  await fixture(async ({ db, input, args, deps, out }) => {
    writeFileSync(input, JSON.stringify({ complete: false, events: [event()],
      failed_sources: [{ id: 'ktm-154', name: 'Trailmandu Nepal', status: 'partial', errors: ['Expected event markup missing'] }] }))
    await main([...args, '--apply'], deps)
    assert.equal(db.prepare('SELECT count(*) AS n FROM listings').get().n, 1)
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
    assert.equal(report.verified, true)
    assert.deepEqual(report.summary.failed_sources, ['ktm-154'])
  })
})

test('incomplete inventories that do not name their failures, and unknown sources, fail before database access', async () => {
  await fixture(async ({ save, input, args, deps }) => {
    const inaccessible = { ...deps, connect: () => { throw Error('Database must not be reached') } }
    writeFileSync(input, JSON.stringify({ complete: false, events: [event()] }))
    await assert.rejects(main(args, inaccessible), /incomplete/)
    writeFileSync(input, JSON.stringify({ complete: true }))
    await assert.rejects(main(args, inaccessible), /no events list/)
    save([event({ source_id: 'unknown' })])
    await assert.rejects(main(args, inaccessible), /Unknown or disabled/)
    assert.throws(() => options([...args, '--publish']), /Unknown option/)
    assert.throws(() => options([...args, '--apply', '--dry-run']), /cannot be combined/)
  })
})
