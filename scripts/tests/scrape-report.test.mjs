import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { options, report, MAX_ARCHIVE_BYTES } from '../scrape-report.mjs'

const env = { NEPSCENE_API_URL: 'https://nepscene.test/', SCRAPE_REPORT_TOKEN: 'shh' }

function fakeFetch(handler) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    const { status = 200, body = {} } = handler(url, init) ?? {}
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { fetch, calls }
}

test('a scheduled run registers itself; a console-started one reports it has begun', async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: { id: 'run_1' } }))
  assert.deepEqual(await report(options(['start', '--github-run-id', '42', '--apply', 'production']), { env, fetch }), { id: 'run_1' })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, 'https://nepscene.test/api/internal/scrape-runs')
  assert.equal(calls[0].headers.authorization, 'Bearer shh')
  assert.deepEqual(JSON.parse(calls[0].body), { trigger: 'schedule', github_run_id: 42, apply_env: 'production' })

  await report(options(['start', '--run-id', 'run_9', '--github-run-id', '43']), { env, fetch })
  assert.equal(calls[1].method, 'PATCH')
  assert.equal(calls[1].url, 'https://nepscene.test/api/internal/scrape-runs/run_9')
  assert.deepEqual(JSON.parse(calls[1].body), { status: 'running', github_run_id: 43 })
})

test('finish uploads the archive first, then the verdict from summary.json', async () => {
  const summary = { complete: false, jobs: [{ name: 'khalti', success: true }, { name: 'venues', success: false }] }
  const files = { '/out/summary.json': JSON.stringify(summary), '/out.tgz': Buffer.from('tar') }
  const { fetch, calls } = fakeFetch((url) => ({ body: url.endsWith('/output') ? { output_key: 'scrapes/run_1.tar.gz' } : { id: 'run_1' } }))
  const result = await report(options(['finish', '--run-id', 'run_1', '--output', '/out', '--archive', '/out.tgz']),
    { env, fetch, readFile: (f) => files[f], fileSize: () => 3 })
  assert.deepEqual(result, { id: 'run_1', status: 'failed', output_key: 'scrapes/run_1.tar.gz' })
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].headers['content-type'], 'application/gzip')
  assert.equal(calls[1].method, 'PATCH')
  const verdict = JSON.parse(calls[1].body)
  assert.equal(verdict.status, 'failed')
  assert.equal(verdict.error, 'venues failed')
  assert.deepEqual(verdict.summary, summary)
})

test('a missing summary or an oversized archive is reported as a failed run, not a crash', async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: { id: 'run_2' } }))
  const result = await report(options(['finish', '--run-id', 'run_2', '--output', '/nowhere', '--archive', '/big.tgz']),
    { env, fetch, readFile: (f) => { if (f.endsWith('summary.json')) throw Error('ENOENT'); return Buffer.alloc(0) }, fileSize: () => MAX_ARCHIVE_BYTES + 1 })
  assert.equal(result.status, 'failed')
  assert.equal(calls.length, 1, 'the oversized archive is not uploaded')
  const verdict = JSON.parse(calls[0].body)
  assert.match(verdict.error, /No summary\.json/)
  assert.match(verdict.error, /limit is/)
})

test('an API refusal and a missing token both stop the script with a reason', async () => {
  const { fetch } = fakeFetch(() => ({ status: 401, body: { error: 'nope' } }))
  await assert.rejects(report(options(['start', '--github-run-id', '1']), { env, fetch }), /HTTP 401/)
  await assert.rejects(report(options(['start', '--github-run-id', '1']), { env: {}, fetch }), /must both be set/)
  assert.throws(() => options(['finish', '--run-id', 'x']), /needs --run-id and --output/)
  assert.throws(() => options(['start', '--bogus', '1']), /Unknown option/)
})
