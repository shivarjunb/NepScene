#!/usr/bin/env node
/**
 * The performance budget, asserted in CI (#39).
 *
 * **What this measures, stated plainly.** Frame rate during a pan on a
 * mid-range Android over throttled 3G is the criterion that matters most and
 * it is the one nothing in CI can honestly claim to have measured — it stays a
 * manual line in #39's test plan. What CI *can* measure, and what actually
 * decides whether a phone on a slow connection ever reaches an interactive
 * map, is how many bytes have to arrive first.
 *
 * So the budget is the transferred weight of what the shell loads before it
 * can paint, gzipped, because that is what crosses the wire. The shell says
 * what that is — its `<script type="module">`, its `modulepreload`s and its
 * stylesheets — so this reads the built `index.html` rather than summing the
 * assets directory, which since route splitting also holds the wizard, the
 * queue, the gallery and the map, none of which is fetched until it is asked
 * for. Those are ratcheted too, separately, so weight cannot leave the first
 * paint by moving into a chunk nobody looks at.
 *
 * **It is a ratchet, not a target.** The numbers below are the measured floor
 * plus a little headroom, so a change that adds weight fails here and has to
 * be argued for rather than noticed six months later. They are deliberately
 * *not* set to what #39's 1.5-second-on-3G criterion would require — see
 * TARGET_KB below, which is not met and says so rather than being quietly
 * redefined as met.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const CLIENT = 'dist/client'
const SHELL = join(CLIENT, 'index.html')

/**
 * The ratchet. Measured 2026-09-12, after route splitting (#39): the first
 * paint is 85.4 KB of JavaScript, 9.9 KB of CSS and a 1.2 KB shell; the
 * deferred chunks together are 30.7 KB. Roughly 8% headroom on each, so an
 * ordinary feature does not trip it and a new dependency does.
 */
const BUDGETS_KB = { js: 92, css: 12, total: 104, deferred: 33 }

/**
 * What #39's "initial interactive paint under 1.5 seconds on 3G" would
 * actually require.
 *
 * A regulatory 3G connection carries about 400kbit/s, and after TCP and TLS
 * setup roughly 50KB reaches the page each second. Parse and execute on a
 * mid-range Android costs at least as long again as the download for a bundle
 * this size. That leaves something near 40KB gzipped for a 1.5-second
 * interactive paint.
 *
 * Where the gap is, measured from the source map on 2026-09-12: NepScene's
 * own code on the first paint is 35 KB gzipped, inside the target. React DOM
 * is 55 KB on its own — more than the whole target before a line of the app
 * arrives. Route splitting has done what it can; what is left is the choice
 * of renderer, which is a product decision and not a build setting.
 *
 * Recorded rather than enforced, on purpose: failing CI on a number nothing
 * currently meets would mean turning the check off, and a check that is off is
 * worth less than a number written down.
 */
const TARGET_KB = 40

const kb = (bytes) => bytes / 1024
const gz = (buffer) => gzipSync(buffer, { level: 9 }).length
const weigh = (href) => gz(readFileSync(join(CLIENT, href)))

const shellHtml = readFileSync(SHELL, 'utf8')

/**
 * What the shell asks for before it can paint. Vite writes the entry as a
 * module script, its static dependencies as modulepreloads and its CSS as
 * stylesheets; anything reached only by `import()` appears in none of these.
 */
const firstPaint = [
  ...shellHtml.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g),
  ...shellHtml.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
  ...shellHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g),
].map((match) => match[1])

/** Everything else the build wrote is reached by `import()`, or not at all. */
const deferredFiles = readdirSync(join(CLIENT, 'assets'))
  .filter((name) => /\.(js|css)$/.test(name))
  .map((name) => `assets/${name}`)
  .filter((file) => !firstPaint.includes(`/${file}`))

let js = 0
let css = 0
const files = []
for (const href of firstPaint) {
  const bytes = weigh(href)
  if (href.endsWith('.js')) js += bytes
  else if (href.endsWith('.css')) css += bytes
  else continue
  files.push([href.replace(/^\/assets\//, ''), bytes])
}

const shell = gz(readFileSync(SHELL))
const total = js + css + shell

const deferred = deferredFiles.map((file) => [file.replace(/^assets\//, ''), weigh(file)])
const deferredTotal = deferred.reduce((sum, [, bytes]) => sum + bytes, 0)

const rows = [
  ['javascript', kb(js), BUDGETS_KB.js],
  ['css', kb(css), BUDGETS_KB.css],
  ['first paint (with the shell)', kb(total), BUDGETS_KB.total],
  ['deferred chunks', kb(deferredTotal), BUDGETS_KB.deferred],
]

const failures = rows.filter(([, actual, budget]) => actual > budget)

const list = (entries) => {
  for (const [name, bytes] of entries.sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kb(bytes).toFixed(1).padStart(7)} KB  ${name}`)
  }
}

console.log('First paint, gzipped:\n')
list(files)
console.log('\nDeferred until a page asks for them:\n')
list(deferred)
console.log()
for (const [name, actual, budget] of rows) {
  const mark = actual > budget ? 'OVER' : 'ok'
  console.log(`  ${actual.toFixed(1).padStart(7)} KB / ${String(budget).padStart(3)} KB  ${name}  [${mark}]`)
}

console.log(
  `\n  #39's 1.5s-on-3G target is ~${TARGET_KB} KB on the first paint; we ship ${kb(total).toFixed(1)} KB,`
  + '\n  of which React DOM is more than the whole target. Not met, and not enforced —'
  + '\n  see the note in scripts/check-budget.mjs.',
)

if (failures.length > 0) {
  console.error('\nOver budget:')
  for (const [name, actual, budget] of failures) {
    console.error(`  ${name}: ${actual.toFixed(1)} KB against a budget of ${budget} KB`)
  }
  console.error(
    '\nThis is a ratchet. If the weight is justified, raise the budget in'
    + '\nscripts/check-budget.mjs in the same commit and say why.',
  )
  process.exit(1)
}
