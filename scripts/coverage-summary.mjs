#!/usr/bin/env node
/**
 * Render the coverage summary as markdown (#10).
 *
 * Written to the job summary and posted as a PR comment. Exits 0 with no output
 * if the report is missing, so a failed test run does not also fail here.
 *
 * Usage: node scripts/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"
 */
import { readFileSync, existsSync } from 'node:fs'

const REPORT = 'coverage/coverage-summary.json'
if (!existsSync(REPORT)) process.exit(0)

const { total } = JSON.parse(readFileSync(REPORT, 'utf8'))
const metrics = ['statements', 'branches', 'functions', 'lines']

console.log('## Coverage\n')
console.log('| Metric | Covered | Count |')
console.log('|---|---|---|')
for (const metric of metrics) {
  const { pct, covered, total: count } = total[metric]
  console.log(`| ${metric} | ${pct}% | ${covered}/${count} |`)
}
console.log('\nThresholds are enforced in `vitest.config.ts` at the measured floor — a drop fails the build.')
