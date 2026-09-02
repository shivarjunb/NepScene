#!/usr/bin/env node
/**
 * Migration hygiene (#12): unique, gapless, forward-only numbering.
 *
 * Usage: node scripts/check-migrations.mjs
 */
import { readdirSync, existsSync } from 'node:fs'
import { duplicateMigrationPrefixes, missingMigrationNumbers } from './lib/guards.mjs'

const DIR = 'migrations'

if (!existsSync(DIR)) {
  console.log('::notice::No migrations directory — nothing to check.')
  process.exit(0)
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.sql'))
const duplicates = duplicateMigrationPrefixes(files)
const missing = missingMigrationNumbers(files)

let failed = false

if (duplicates.length > 0) {
  console.log(`::error::Duplicate migration prefixes: ${duplicates.join(', ')}`)
  failed = true
}

if (missing.length > 0) {
  const numbers = missing.map((n) => String(n).padStart(4, '0')).join(', ')
  console.log(`::error::Gap in migration numbering: ${numbers} missing. Numbering must not go backwards — wrangler skips a migration numbered below one already applied.`)
  failed = true
}

if (failed) process.exit(1)

console.log(`Migration numbering is unique and gapless (${files.length} migrations).`)
