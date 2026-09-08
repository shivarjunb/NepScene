import { describe, expect, it } from 'vitest'
import { MAX_TAGS_PER_LISTING, normaliseTag, normaliseTags } from '../../api/catalog/tags'

/**
 * #22 — tags are free-form, but a browse page split across three spellings of
 * "open mic" is worse than no browse page.
 */
describe('tag normalisation', () => {
  it('collapses spelling and punctuation to one slug', () => {
    for (const spelling of ['Open Mic', 'open mic', 'Open-Mic', '  OPEN   MIC  ']) {
      expect(normaliseTag(spelling)).toBe('open-mic')
    }
  })

  it('transliterates Devanagari rather than dropping it', () => {
    // The same rule slugs use, so a tag is always safe in a URL (#24).
    expect(normaliseTag('चाडपर्व')).toMatch(/^[a-z0-9-]+$/)
  })

  it('rejects a tag with nothing in it', () => {
    expect(normaliseTag('   ')).toBeNull()
    expect(normaliseTag('!!!')).toBeNull()
  })

  it('keeps the first spelling as the label', () => {
    expect(normaliseTags(['Open Mic'])).toEqual([{ slug: 'open-mic', label: 'Open Mic' }])
  })

  it('collapses duplicates while preserving order', () => {
    expect(normaliseTags(['Live Music', 'live-music', 'Outdoors'])).toEqual([
      { slug: 'live-music', label: 'Live Music' },
      { slug: 'outdoors', label: 'Outdoors' },
    ])
  })

  it('caps how many tags one listing can carry', () => {
    const many = Array.from({ length: 30 }, (_, n) => `tag-${n}`)
    expect(normaliseTags(many)).toHaveLength(MAX_TAGS_PER_LISTING)
  })

  it('drops the unusable rather than failing the whole list', () => {
    expect(normaliseTags(['!!!', 'Holi'])).toEqual([{ slug: 'holi', label: 'Holi' }])
  })
})
