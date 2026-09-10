import { describe, expect, it } from 'vitest'
import {
  MAX_SQL_VARIABLES, buildCandidateQuery, buildFacetQuery, buildFeedQuery, escapeLike,
} from '../../api/catalog/queries'
import { parseTerms } from '../../api/catalog/terms'
import { whenBuckets } from '../../api/catalog/when'

const base = { includePast: false, limit: 20, now: '2026-09-02T00:00:00.000Z' }

describe('buildFeedQuery', () => {
  it('always filters to published', () => {
    expect(buildFeedQuery(base).sql).toContain(`l.status = 'published'`)
  })

  it('is upcoming by default and bounded', () => {
    const { sql, params } = buildFeedQuery(base)
    expect(sql).toContain('COALESCE(l.ends_at, l.starts_at) >= ?')
    expect(sql).toContain('LIMIT ?')
    // limit + 1 answers has_more without a second COUNT query.
    expect(params.at(-1)).toBe(21)
  })

  it('drops the time window only when past is explicitly asked for', () => {
    expect(buildFeedQuery({ ...base, includePast: true }).sql)
      .not.toContain('COALESCE(l.ends_at, l.starts_at) >= ?')
  })

  it('orders by the tuple the cursor and the index use', () => {
    expect(buildFeedQuery(base).sql).toContain('ORDER BY l.starts_at ASC, l.id ASC')
  })

  it('pages by keyset, not offset', () => {
    const { sql, params } = buildFeedQuery({
      ...base, cursor: { startsAt: '2026-09-10T00:00:00.000Z', id: 'lst_x' },
    })
    expect(sql).not.toContain('OFFSET')
    // Numbered placeholders, and the cursor timestamp is bound once and read
    // twice — see the Binder in queries.ts and the variable ceiling below.
    expect(sql).toMatch(/\(l\.starts_at > \?\d+ OR \(l\.starts_at = \?\d+ AND l\.id > \?\d+\)\)/)
    expect(params).toContain('lst_x')
    expect(params.filter((value) => value === '2026-09-10T00:00:00.000Z')).toHaveLength(1)
  })

  it('walks a past list backwards, cursor comparison included', () => {
    const { sql } = buildFeedQuery({
      ...base, includePast: true, finishedBefore: base.now, order: 'desc',
      cursor: { startsAt: '2026-08-10T00:00:00.000Z', id: 'lst_x' },
    })
    expect(sql).toContain('COALESCE(l.ends_at, l.starts_at) < ?')
    expect(sql).toContain('ORDER BY l.starts_at DESC, l.id DESC')
    expect(sql).toMatch(/\(l\.starts_at < \?\d+ OR \(l\.starts_at = \?\d+ AND l\.id < \?\d+\)\)/)
  })

  it('binds every filter rather than interpolating it', () => {
    const { sql, params } = buildFeedQuery({ ...base, city: "Kath'mandu" })
    expect(sql).not.toContain("Kath'mandu")
    expect(params).toContain("Kath'mandu")
  })
})

/**
 * D1 refuses a statement with more than a hundred bound variables. It is a
 * hard limit rather than a budget, so the widest query the search can build
 * has to be measured rather than reasoned about — a four-word query where
 * every word is an alias group, with every filter applied at once.
 */
describe('the D1 variable ceiling', () => {
  const worst = {
    ...base,
    terms: parseTerms('kathmandu pokhara thamel lalitpur'),
    category: 'concerts', tag: 'live-music', artist: 'kutumba', city: 'Kathmandu',
    venue: 'purple-haze', organizer: 'himalayan-sound', listingType: 'free',
    priceBand: 'free', featured: true, from: base.now, to: base.now,
    box: { minLat: 27, maxLat: 28, minLng: 85, maxLng: 86 },
  }

  it('keeps the widest possible candidate query inside it', () => {
    const { params } = buildCandidateQuery(worst, {
      candidates: 200, popularitySince: base.now,
    })
    expect(params.length).toBeLessThanOrEqual(MAX_SQL_VARIABLES)
  })

  it('keeps the facet query inside it, despite repeating the WHERE four times', () => {
    const { sql, params } = buildFacetQuery(worst, whenBuckets(new Date(base.now)))
    expect(params.length).toBeLessThanOrEqual(MAX_SQL_VARIABLES)
    // Four aggregates is also the ceiling: D1 refuses a fifth compound term.
    expect(sql.match(/UNION ALL/g)).toHaveLength(3)
  })

  it('binds a repeated spelling once rather than once per column', () => {
    const { params } = buildFeedQuery({ ...base, terms: parseTerms('jazz') })
    // One word, one pattern, eleven columns — and one variable.
    expect(params.filter((value) => String(value).includes('jazz'))).toHaveLength(1)
  })
})

describe('escapeLike', () => {
  it('treats wildcards in user input as literals', () => {
    expect(escapeLike('100%_off')).toBe('100\\%\\_off')
  })
})
