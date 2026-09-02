import { describe, expect, it } from 'vitest'
import { canonicalCacheKey } from '../../api/lib/cache'

const key = (url: string) =>
  canonicalCacheKey(new URL(url), ['category', 'limit'], '3')

describe('canonicalCacheKey', () => {
  it('is order-independent, so one page is one cache entry', () => {
    expect(key('https://n.np/api/catalog/listings?limit=20&category=concerts').url)
      .toBe(key('https://n.np/api/catalog/listings?category=concerts&limit=20').url)
  })

  it('drops parameters that do not change the response', () => {
    // A crawler appending utm_* must not shard the cache into useless copies.
    expect(key('https://n.np/api/catalog/listings?category=concerts&utm_source=fb').url)
      .toBe(key('https://n.np/api/catalog/listings?category=concerts').url)
  })

  it('carries the version, which is how publishing invalidates every key', () => {
    const before = canonicalCacheKey(new URL('https://n.np/api/catalog/listings'), [], '3')
    const after = canonicalCacheKey(new URL('https://n.np/api/catalog/listings'), [], '4')
    expect(before.url).not.toBe(after.url)
  })
})
