#!/usr/bin/env node
/**
 * Schema drift: does the database agree with its own migration ledger?
 *
 * `wrangler d1 migrations apply` decides what to run from `d1_migrations`, and
 * that ledger only records what wrangler itself applied. Apply a migration file
 * any other way and the ledger does not learn about it, so the next deploy
 * replays the file against objects that already exist and fails partway:
 *
 *     ✘ [ERROR] duplicate column name: import_source_id [code: 7500]
 *
 * `apply` has no transaction spanning the statements in a file, so that replay
 * has already run everything above the line it died on. This runs first, before
 * wrangler touches anything, and turns the puzzle into a sentence.
 *
 * Usage:
 *   node scripts/check-schema-drift.mjs --env staging
 *   node scripts/check-schema-drift.mjs --env production --database nepscene-production
 *   node scripts/check-schema-drift.mjs --local
 */
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runWrangler, parseD1Output } from './lib/d1.mjs'
import { schemaDrift } from './lib/guards.mjs'

const DIR = 'migrations'

function options(args) {
  const o = { env: null, database: null, local: false, help: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--local') o.local = true
    else if (a === '--help' || a === '-h') o.help = true
    else if (a === '--env' || a === '--database') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${a}`)
      o[a.slice(2)] = args[++i]
    } else throw Error(`Unknown argument: ${a}`)
  }
  if (!o.help && !o.local && !o.env) throw Error('Pass --env <name>, or --local for the development database.')
  // Every environment names its database after itself (wrangler.jsonc).
  o.database ??= o.local ? 'nepscene-local' : `nepscene-${o.env}`
  return o
}

/** One round trip per question; a failed statement throws rather than reading empty. */
function querier(o) {
  const wrangler = createRequire(join(process.cwd(), 'package.json')).resolve('wrangler')
  const target = o.local
    ? [o.database, '--local']
    : [o.database, '--env', o.env, '--remote']
  return (sql) => parseD1Output(runWrangler(
    [wrangler, 'd1', 'execute', ...target, '--command', sql, '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] },
  ))
}

/**
 * Tables, indexes and columns as the database actually has them.
 *
 * D1's own bookkeeping is not part of the schema under review, and the filter
 * is not cosmetic: `pragma_table_info` over an internal table is refused by the
 * authorizer with `not authorized: SQLITE_AUTH`, so `d1_migrations` and the
 * `_cf_*` tables have to be excluded inside the query rather than after it.
 */
const NOT_INTERNAL = (column) =>
  `${column} NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND ${column} NOT LIKE 'd1\\_%' ESCAPE '\\' AND ${column} NOT LIKE '\\_cf\\_%' ESCAPE '\\'`

function liveSchema(query) {
  const live = { tables: [], indexes: [], columns: {} }

  for (const { kind, name } of query(
    `SELECT type AS kind, name FROM sqlite_master WHERE type IN ('table', 'index') AND ${NOT_INTERNAL('name')}`)) {
    if (kind === 'table') live.tables.push(name)
    else live.indexes.push(name)
  }

  for (const { tbl, col } of query(
    `SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p
       WHERE m.type = 'table' AND ${NOT_INTERNAL('m.name')}`.replace(/\s+/g, ' '))) {
    (live.columns[tbl] ??= []).push(col)
  }

  return live
}

/** An unmigrated database has no ledger yet, and nothing can be out of step with it. */
function applied(query) {
  if (!query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'`).length) return []
  return query('SELECT name FROM d1_migrations ORDER BY id').map((row) => row.name)
}

export function main(args = process.argv.slice(2)) {
  const o = options(args)
  if (o.help) {
    console.log(`Schema drift: does the database agree with its own migration ledger?
  node scripts/check-schema-drift.mjs --env staging
  node scripts/check-schema-drift.mjs --local

--database NAME overrides the default of nepscene-<env>.`)
    return
  }

  if (!existsSync(DIR)) {
    console.log('::notice::No migrations directory — nothing to check.')
    return
  }

  const query = querier(o)
  const live = liveSchema(query)
  const ledger = new Set(applied(query))

  const files = readdirSync(DIR).filter((name) => name.endsWith('.sql')).sort()
  const pending = files
    .filter((name) => !ledger.has(name))
    .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }))

  const where = `${o.database}${o.local ? ' (local)' : ''}`

  if (pending.length === 0) {
    console.log(`${where}: ledger is level with ${files.length} migrations — nothing pending.`)
    return
  }

  const conflicts = schemaDrift(pending, live)
  if (conflicts.length === 0) {
    console.log(`${where}: ${pending.length} pending (${pending.map((p) => p.name).join(', ')}), no drift.`)
    return
  }

  const byMigration = new Map()
  for (const c of conflicts) {
    const described = c.kind === 'column' ? `column ${c.table}.${c.name}` : `${c.kind} ${c.name}`
    byMigration.set(c.migration, [...(byMigration.get(c.migration) ?? []), described])
  }

  console.log(`::error::Schema drift on ${where}: the database already has objects that pending migrations would create. Applying them would fail partway through, leaving the file half-run.`)
  for (const [migration, objects] of byMigration) {
    console.log(`::error::  ${migration} would recreate: ${objects.join(', ')}`)
  }
  console.log('::error::This means a migration file was applied outside `wrangler d1 migrations apply` — never run one with `d1 execute --file`. See docs/DEVOPS.md § Repairing a drifted ledger.')
  process.exitCode = 1
}

if (process.argv[1]?.endsWith('check-schema-drift.mjs')) {
  try { main() } catch (error) {
    console.log(`::error::${error.message}`)
    process.exitCode = 1
  }
}
