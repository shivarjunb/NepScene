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
 * So the budget is the transferred weight of the client bundle, gzipped,
 * because that is what crosses the wire.
 *
 * **It is a ratchet, not a target.** The numbers below are the measured floor
 * plus a little headroom, so a change that adds weight fails here and has to
 * be argued for rather than noticed six months later. They are deliberately
 * *not* set to what #39's 1.5-second-on-3G criterion would require — see
 * TARGET_KB below, which is not yet met and says so rather than being quietly
 * redefined as met.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const ASSETS = 'dist/client/assets'
const SHELL = 'dist/client/index.html'

/**
 * The ratchet. Measured 2026-09-10 at 105.7 / 9.7 / 116.7 KB gzipped, with
 * roughly 8% headroom so an ordinary feature does not trip it and a new
 * dependency does.
 */
const BUDGETS_KB = { js: 115, css: 12, total: 128 }

/**
 * What #39's "initial interactive paint under 1.5 seconds on 3G" would
 * actually require.
 *
 * A regulatory 3G connection carries about 400kbit/s, and after TCP and TLS
 * setup roughly 50KB reaches the page each second. Parse and execute on a
 * mid-range Android costs at least as long again as the download for a bundle
 * this size. That leaves something near 40KB gzipped for a 1.5-second
 * interactive paint — a third of what is shipped today.
 *
 * Recorded rather than enforced, on purpose: failing CI on a number nothing
 * currently meets would mean turning the check off, and a check that is off is
 * worth less than a number written down. Closing the gap is route-level code
 * splitting — the wizard, the moderation queue and the gallery are on every
 * first paint today and are needed by almost nobody on one.
 */
const TARGET_KB = 40

const kb = (bytes) => bytes / 1024
const gz = (buffer) => gzipSync(buffer, { level: 9 }).length

let js = 0
let css = 0
const files = []

for (const name of readdirSync(ASSETS)) {
  const bytes = gz(readFileSync(join(ASSETS, name)))
  if (name.endsWith('.js')) js += bytes
  else if (name.endsWith('.css')) css += bytes
  else continue
  files.push([name, bytes])
}

const shell = gz(readFileSync(SHELL))
const total = js + css + shell

const rows = [
  ['javascript', kb(js), BUDGETS_KB.js],
  ['css', kb(css), BUDGETS_KB.css],
  ['total (with the shell)', kb(total), BUDGETS_KB.total],
]

const failures = rows.filter(([, actual, budget]) => actual > budget)

console.log('Client bundle, gzipped:\n')
for (const [name, bytes] of files.sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kb(bytes).toFixed(1).padStart(7)} KB  ${name}`)
}
console.log()
for (const [name, actual, budget] of rows) {
  const mark = actual > budget ? 'OVER' : 'ok'
  console.log(`  ${actual.toFixed(1).padStart(7)} KB / ${String(budget).padStart(3)} KB  ${name}  [${mark}]`)
}

console.log(
  `\n  #39's 1.5s-on-3G target is ~${TARGET_KB} KB total; we ship ${kb(total).toFixed(1)} KB.`
  + '\n  Not met, and not enforced — see the note in scripts/check-budget.mjs.',
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
