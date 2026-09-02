import { describe, expect, it } from 'vitest'
import { buildFeedQuery, escapeLike } from '../../api/catalog/queries'

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
    expect(sql).toContain('(l.starts_at > ? OR (l.starts_at = ? AND l.id > ?))')
    expect(params).toContain('lst_x')
  })

  it('binds every filter rather than interpolating it', () => {
    const { sql, params } = buildFeedQuery({ ...base, city: "Kath'mandu" })
    expect(sql).not.toContain("Kath'mandu")
    expect(params).toContain("Kath'mandu")
  })
})

describe('escapeLike', () => {
  it('treats wildcards in user input as literals', () => {
    expect(escapeLike('100%_off')).toBe('100\\%\\_off')
  })
})
