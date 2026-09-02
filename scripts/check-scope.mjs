#!/usr/bin/env node
/**
 * Scope guard (#10, docs/SCOPE.md): make commerce vocabulary visible in review.
 *
 * A warning, not a gate. NepScene renders offers and never computes them, but
 * legitimate uses exist — the point is that erosion is noticed, not blocked.
 *
 * Usage: node scripts/check-scope.mjs [dir...]
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { commerceHits } from './lib/guards.mjs'

const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['api', 'app']
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (EXTENSIONS.some((ext) => path.endsWith(ext))) yield path
  }
}

const present = roots.filter((dir) => existsSync(dir))
if (present.length === 0) {
  console.log('::notice::No source directories yet — scope guard idle.')
  process.exit(0)
}

const hits = []
for (const root of present) {
  for (const file of walk(root)) {
    hits.push(...commerceHits(readFileSync(file, 'utf8'), file))
  }
}

if (hits.length === 0) {
  console.log('No commerce concerns detected.')
  process.exit(0)
}

console.log(`::warning::${hits.length} commerce term(s) found — confirm this belongs in NepScene (docs/SCOPE.md)`)
for (const hit of hits.slice(0, 20)) {
  console.log(`::warning file=${hit.file},line=${hit.line}::${hit.term}: ${hit.text.slice(0, 160)}`)
}
