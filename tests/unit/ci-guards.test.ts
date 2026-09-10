import { describe, expect, it } from 'vitest'
import {
  duplicateMigrationPrefixes,
  missingMigrationNumbers,
  commerceHits,
  credentialHits,
  migrationCreates,
  schemaDrift,
} from '../../scripts/lib/guards.mjs'
import {
  parseTscErrors,
  parseEslintReport,
  toWorkflowCommand,
  type Annotation,
} from '../../scripts/lib/annotations.mjs'

/**
 * The guards are what CI trusts, so they are tested against known-bad fixtures
 * rather than assumed correct (#10's test plan). The duplicate fixture is not
 * invented: 0009, 0010, 0016 and 0019 are all duplicated in WaahTickets.
 */
describe('migration numbering guard', () => {
  it('accepts a clean, gapless sequence', () => {
    const files = ['0001_init.sql', '0002_venues.sql', '0003_media.sql']
    expect(duplicateMigrationPrefixes(files)).toEqual([])
    expect(missingMigrationNumbers(files)).toEqual([])
  })

  it('rejects the duplicate prefixes WaahTickets actually shipped', () => {
    const files = [
      '0009_a.sql', '0009_b.sql',
      '0010_a.sql', '0010_b.sql',
      '0016_a.sql', '0016_b.sql',
      '0019_a.sql', '0019_b.sql',
      '0001_init.sql',
    ]
    expect(duplicateMigrationPrefixes(files)).toEqual(['0009', '0010', '0016', '0019'])
  })

  it('rejects a gap, because wrangler silently skips a number below the applied high-water mark', () => {
    expect(missingMigrationNumbers(['0001_a.sql', '0003_c.sql'])).toEqual([2])
  })

  it('ignores files that are not numbered migrations', () => {
    expect(duplicateMigrationPrefixes(['README.md', 'notes.txt'])).toEqual([])
    expect(missingMigrationNumbers(['README.md'])).toEqual([])
  })
})

describe('scope guard', () => {
  it('finds commerce vocabulary and reports where', () => {
    const source = ['const listing = 1', 'await createCheckout(cart)', 'const x = 2'].join('\n')
    const hits = commerceHits(source, 'api/catalog/queries.ts')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ file: 'api/catalog/queries.ts', line: 2, term: 'checkout' })
  })

  it('catches every casing the same concept arrives in', () => {
    expect(commerceHits('const session = createCheckout(cart)', 'a.ts')).toHaveLength(1)
    expect(commerceHits('type OrderItemsRow = { id: string }', 'a.ts')[0]?.term).toBe('order_items')
    expect(commerceHits('const orderItems = []', 'a.ts')[0]?.term).toBe('order_items')
    expect(commerceHits('SELECT * FROM order_items', 'a.ts')[0]?.term).toBe('order_items')
  })

  it('matches on word boundaries, not substrings', () => {
    expect(commerceHits('const checkoutish = 1', 'a.ts')).toHaveLength(0)
    expect(commerceHits('const precheckouted = 1', 'a.ts')).toHaveLength(0)
  })

  it('is quiet on catalogue code', () => {
    expect(commerceHits('export const priceFrom = (l) => l.price_from', 'a.ts')).toEqual([])
  })
})

describe('PR annotations', () => {
  it('parses tsc output into placeable annotations', () => {
    const output = [
      'api/catalog/queries.ts(12,5): error TS2345: Argument of type \'string\' is not assignable.',
      'Found 1 error in 1 file.',
    ].join('\n')
    expect(parseTscErrors(output)).toEqual([{
      file: 'api/catalog/queries.ts',
      line: 12,
      col: 5,
      level: 'error',
      message: "TS2345: Argument of type 'string' is not assignable.",
    }])
  })

  it('ignores tsc summary lines', () => {
    expect(parseTscErrors('Found 0 errors.\n\n')).toEqual([])
  })

  it('parses an eslint json report, keeping the rule id', () => {
    const report = [{
      filePath: '/repo/api/lib/slug.ts',
      messages: [{ line: 4, column: 9, severity: 2, message: 'x is unused', ruleId: 'no-unused-vars' }],
    }]
    expect(parseEslintReport(report)[0]).toMatchObject({
      file: '/repo/api/lib/slug.ts',
      level: 'error',
      message: 'x is unused (no-unused-vars)',
    })
  })

  it('separates warnings from errors', () => {
    const report = [{ filePath: '/repo/a.ts', messages: [{ line: 1, column: 1, severity: 1, message: 'meh' }] }]
    expect(parseEslintReport(report)[0]?.level).toBe('warning')
  })

  it('emits a repo-relative workflow command', () => {
    const annotation: Annotation = { file: '/repo/api/lib/slug.ts', line: 4, col: 9, level: 'error', message: 'boom' }
    expect(toWorkflowCommand(annotation, '/repo'))
      .toBe('::error file=api/lib/slug.ts,line=4,col=9::boom')
  })

  it('escapes newlines, which would otherwise truncate the command', () => {
    const annotation: Annotation = { file: 'a.ts', line: 1, col: 1, level: 'error', message: 'line one\nline two' }
    expect(toWorkflowCommand(annotation)).toBe('::error file=a.ts,line=1,col=1::line one%0Aline two')
  })
})

/**
 * The credential guard exists because push protection has a hole, so the
 * fixtures here are not invented either: the Google API key shape below is the
 * one that pushed cleanly to this repository while a Slack token and a Stripe
 * key on the very next line were both refused.
 *
 * Fixtures are concatenated rather than written whole so this file does not
 * trip the guard when it scans the tree it lives in.
 */
describe('committed credential guard', () => {
  const googleKey = 'AIza' + 'b3F9kQ2xLmN7pR4tV8wY1zA5cD6eG0hJ2kL'

  it('catches the key shape GitHub push protection let through', () => {
    const hits = credentialHits(`VITE_GOOGLE_MAPS_API_KEY=${googleKey}`, '.dev.vars')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ file: '.dev.vars', line: 1, kind: 'Google API key' })
  })

  it('catches a token that has no recognisable shape, by the name it is given', () => {
    const hits = credentialHits('CLOUDFLARE_API_TOKEN=' + 'k'.repeat(20) + 'Zq7', 'notes.md')
    expect(hits[0]?.kind).toBe('CLOUDFLARE_API_TOKEN with a value')
  })

  it('reports one hit per line, at the line, so the fix is not a repository-wide search', () => {
    const text = ['# notes', '', 'GOOGLE_CLIENT_SECRET=' + 'GOCSPX-' + 'a'.repeat(28)].join('\n')
    const hits = credentialHits(text, 'notes.md')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ line: 3, kind: 'Google OAuth client secret' })
  })

  it('ignores everything a repository legitimately writes in those places', () => {
    const benign = [
      'CLOUDFLARE_API_TOKEN=',                                  // .dev.vars.example
      'GOOGLE_CLIENT_SECRET: string',                           // a type annotation
      "env.GOOGLE_CLIENT_SECRET = 'test-secret'",               // a test fixture
      'apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}',          // a workflow reference
      'CLOUDFLARE_ACCOUNT_ID=your-account-id-goes-right-here',  // a placeholder
      'CLOUDFLARE_API_TOKEN=****************************',      // a redacted log line
    ]
    for (const line of benign) {
      expect(credentialHits(line, 'f'), line).toEqual([])
    }
  })

  it('honours the opt-out marker, which is how the patterns avoid matching themselves', () => {
    expect(credentialHits(`key = ${googleKey} // secret-guard:allow`, 'f')).toEqual([])
  })
})

/**
 * The drift guard exists because of a real incident: 0012 was applied to
 * staging and to production with `d1 execute --file`, which leaves the objects
 * in place and the `d1_migrations` ledger none the wiser. The next deploy
 * replayed the file and died on statement one — `duplicate column name:
 * import_source_id` — after which production carried 0012's columns on a ledger
 * that still read 0004. The fixtures below are the two migrations involved.
 */
const M0012 = `
-- Stable source identity and content identity protect repeated/concurrent imports.
ALTER TABLE listings ADD COLUMN import_source_id TEXT;
ALTER TABLE listings ADD COLUMN import_fingerprint TEXT;
CREATE UNIQUE INDEX idx_listing_import_source ON listings(import_source_id)
  WHERE import_source_id IS NOT NULL;
CREATE TABLE import_sources (
  source_id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE
);
CREATE INDEX idx_import_sources_listing ON import_sources(listing_id);
`

/** The 0008 shape: SQLite cannot drop NOT NULL in place, so the table is rebuilt. */
const M0008 = `
PRAGMA foreign_keys = OFF;
CREATE TABLE listings_new (id TEXT PRIMARY KEY, starts_at TEXT);
INSERT INTO listings_new SELECT id, starts_at FROM listings;
DROP TABLE listings;
ALTER TABLE listings_new RENAME TO listings;
CREATE INDEX idx_listings_feed ON listings(status, starts_at, id);
PRAGMA foreign_keys = ON;
`

describe('schema drift guard', () => {
  it('reads every kind of object a migration brings into being', () => {
    expect(migrationCreates(M0012)).toEqual([
      { kind: 'table', name: 'import_sources', table: 'import_sources' },
      { kind: 'index', name: 'idx_listing_import_source', table: 'listings' },
      { kind: 'index', name: 'idx_import_sources_listing', table: 'import_sources' },
      { kind: 'column', name: 'import_source_id', table: 'listings' },
      { kind: 'column', name: 'import_fingerprint', table: 'listings' },
    ])
  })

  it('does not count what a table rebuild drops on its way past', () => {
    // `listings` and its indexes are expected to exist before 0008 runs; saying
    // so would make every rebuild migration look like drift forever.
    expect(migrationCreates(M0008)).toEqual([
      { kind: 'table', name: 'listings_new', table: 'listings_new' },
    ])
  })

  it('ignores DDL that only appears in a comment', () => {
    const sql = '-- CREATE TABLE ghosts (id TEXT);\n/* ALTER TABLE listings ADD COLUMN ghost TEXT; */\nCREATE TABLE real_one (id TEXT);'
    expect(migrationCreates(sql)).toEqual([
      { kind: 'table', name: 'real_one', table: 'real_one' },
    ])
  })

  it('reads quoted identifiers, and is not fooled by ADD CONSTRAINT', () => {
    const sql = 'CREATE TABLE "odd name" (id TEXT);\nALTER TABLE `listings` ADD CONSTRAINT c CHECK (id IS NOT NULL);\nALTER TABLE [listings] ADD venue_room TEXT;'
    expect(migrationCreates(sql)).toEqual([
      { kind: 'table', name: 'odd name', table: 'odd name' },
      { kind: 'column', name: 'venue_room', table: 'listings' },
    ])
  })

  it('is silent when the ledger and the schema agree', () => {
    const live = { tables: ['listings'], indexes: [], columns: { listings: ['id'] } }
    expect(schemaDrift([{ name: '0012_katajaam_import.sql', sql: M0012 }], live)).toEqual([])
  })

  it('names the incident: objects present, ledger unaware', () => {
    const live = {
      tables: ['listings', 'import_sources'],
      indexes: ['idx_listing_import_source', 'idx_import_sources_listing'],
      columns: { listings: ['id', 'import_source_id', 'import_fingerprint'] },
    }
    const conflicts = schemaDrift([{ name: '0012_katajaam_import.sql', sql: M0012 }], live)
    expect(conflicts).toHaveLength(5)
    expect(conflicts.every((c) => c.migration === '0012_katajaam_import.sql')).toBe(true)
    expect(conflicts).toContainEqual({
      migration: '0012_katajaam_import.sql',
      kind: 'column', name: 'import_source_id', table: 'listings',
    })
  })

  it('lets a rebuild migration through against the table it is about to rebuild', () => {
    const live = {
      tables: ['listings'],
      indexes: ['idx_listings_feed'],
      columns: { listings: ['id', 'starts_at'] },
    }
    expect(schemaDrift([{ name: '0008_draft_start_optional.sql', sql: M0008 }], live)).toEqual([])
  })
})
