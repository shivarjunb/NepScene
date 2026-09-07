#!/usr/bin/env node
/**
 * No credential is committed (#13).
 *
 * A gate, not a warning: unlike the scope guard, there is no legitimate reason
 * for a live credential to be in the tree, so a hit fails the build.
 *
 * The file set comes from `git ls-files` rather than a directory walk, because
 * the question is precisely "what is committed" — an untracked `.dev.vars` is
 * fine and gitignored, and a walk would flag it and teach everyone to ignore
 * the guard.
 *
 * Usage: node scripts/check-secrets.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { credentialHits } from './lib/guards.mjs'

// Lock files are enormous, machine-written, and full of base64 integrity
// hashes; images and fonts are binary. Neither is where a pasted key lands.
const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml)$|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|pdf|zip)$/i

let tracked
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
} catch {
  console.log('::notice::Not a git checkout — credential guard idle.')
  process.exit(0)
}

const hits = []
for (const file of tracked) {
  if (SKIP.test(file)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue // deleted, or not readable as text
  }
  if (text.includes('\0')) continue
  hits.push(...credentialHits(text, file))
}

if (hits.length === 0) {
  console.log(`No committed credentials detected (${tracked.length} tracked files).`)
  process.exit(0)
}

console.log(`::error::${hits.length} possible credential(s) committed. Rotate the credential first — removing the line does not un-leak it.`)
for (const hit of hits) {
  console.log(`::error file=${hit.file},line=${hit.line}::${hit.kind}: ${hit.text.slice(0, 120)}`)
}
process.exit(1)
