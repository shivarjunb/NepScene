#!/usr/bin/env node
/**
 * Post-deploy smoke test (#11).
 *
 * Three things, in the order they break: the Worker is alive and is the
 * environment we think it is, the catalog read path answers and respects its
 * bound, and the SPA shell serves.
 *
 * The environment assertion matters more than it looks. Assets are served from
 * the edge with an SPA fallback, so a request for an unmatched path returns
 * index.html with a 200 — the earlier smoke test hit `/health` (no `/api`) and
 * would have passed against a completely dead Worker.
 *
 * Usage: node scripts/smoke.mjs https://nepscene-staging.example.workers.dev staging
 */
const [base, expectedEnv] = process.argv.slice(2)

if (!base || !expectedEnv) {
  console.error('usage: node scripts/smoke.mjs <base-url> <environment>')
  process.exit(2)
}

const failures = []
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name} — ${detail}`)
    failures.push(name)
  }
}

const get = async (path, accept = 'application/json') => {
  const response = await fetch(`${base}${path}`, { headers: { accept } })
  return { status: response.status, body: await response.text() }
}

console.log(`Smoke testing ${base} (expecting environment "${expectedEnv}")`)

// 1. The Worker is alive, and it is the right one.
const health = await get('/api/health')
check('health responds 200', health.status === 200, `got ${health.status}`)
let reported = null
try {
  reported = JSON.parse(health.body).environment
} catch {
  check('health returns JSON', false, `body starts: ${health.body.slice(0, 60)}`)
}
check(
  `health reports environment "${expectedEnv}"`,
  reported === expectedEnv,
  `reported "${reported}" — wrong environment deployed, or the SPA fallback answered`,
)

// 2. The catalog read path answers and stays bounded.
const catalog = await get('/api/catalog/listings?limit=5')
check('catalog responds 200', catalog.status === 200, `got ${catalog.status}`)
try {
  const { data, page } = JSON.parse(catalog.body)
  check('catalog returns a data array', Array.isArray(data), `got ${typeof data}`)
  check('catalog respects the limit', Array.isArray(data) && data.length <= 5, `got ${data?.length} rows`)
  check('catalog reports its page bound', page?.limit === 5, `page.limit was ${page?.limit}`)
} catch {
  check('catalog returns JSON', false, `body starts: ${catalog.body.slice(0, 60)}`)
}

// 3. The SPA shell serves.
const shell = await get('/', 'text/html')
check('SPA shell responds 200', shell.status === 200, `got ${shell.status}`)
check('SPA shell has a root element', shell.body.includes('id="root"'), 'no #root in the document')

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll smoke checks passed.')
