import { describe, expect, it } from 'vitest'
import { slugify, uniqueSlug } from '../../api/lib/slug'

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Kathmandu Rock Night')).toBe('kathmandu-rock-night')
  })

  it('strips accents rather than dropping the letter', () => {
    expect(slugify('Pokharā Lakeside')).toBe('pokhara-lakeside')
  })

  it('spells out an ampersand, because "food-drink" reads as a subtraction', () => {
    expect(slugify('Food & Drink')).toBe('food-and-drink')
  })

  it('collapses punctuation and trims the edges', () => {
    expect(slugify('  ¡Hola!  Nepal -- 2026!! ')).toBe('hola-nepal-2026')
  })

  it('never ends on a hyphen after truncation', () => {
    const long = slugify('a'.repeat(78) + ' bcdef')
    expect(long.endsWith('-')).toBe(false)
    expect(long.length).toBeLessThanOrEqual(80)
  })

  it('transliterates rather than giving up on a non-Latin title', () => {
    expect(slugify('इन्द्रजात्रा')).toBe('indrajatra')
  })

  it('still returns empty when there is genuinely nothing to slug', () => {
    expect(slugify('!!! ??? ---')).toBe('')
  })
})

describe('uniqueSlug', () => {
  it('uses the plain slug when it is free', async () => {
    expect(await uniqueSlug('Rock Night', async () => false)).toBe('rock-night')
  })

  it('suffixes until it finds a gap', async () => {
    const taken = new Set(['rock-night', 'rock-night-2', 'rock-night-3'])
    expect(await uniqueSlug('Rock Night', async (c) => taken.has(c))).toBe('rock-night-4')
  })

  it('falls back when the title produces no slug at all', async () => {
    expect(await uniqueSlug('!!! ???', async () => false, 'listing')).toBe('listing')
  })
})
