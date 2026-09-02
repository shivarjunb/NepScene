import { describe, expect, it } from 'vitest'
import {
  duplicateMigrationPrefixes,
  missingMigrationNumbers,
  commerceHits,
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
