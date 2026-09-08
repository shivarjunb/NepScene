import { describe, expect, it } from 'vitest'
import type { CategoryRef } from '../../api/catalog/types'
import { DEFAULT_PIN, resolvePin } from '../../api/catalog/pin'

/**
 * #22 — "pin colour and icon derive from the category with no second field to
 * keep in sync". These are the cases where a stored `map_pin_icon` used to be
 * free to disagree with the chip next to it.
 */
const category = (over: Partial<CategoryRef> = {}): CategoryRef => ({
  slug: 'concerts', name: 'Concerts', color: '#e91e63', icon: 'Music',
  is_primary: true, ...over,
})

describe('pin appearance', () => {
  it('takes icon and colour from the primary category', () => {
    expect(resolvePin([category()])).toEqual({
      icon: 'Music', color: '#e91e63', category: 'concerts',
    })
  })

  it('ignores secondary categories, whatever order they arrive in', () => {
    const secondary = category({ slug: 'nightlife', icon: 'Moon', color: '#06b6d4', is_primary: false })
    expect(resolvePin([secondary, category()])).toEqual(resolvePin([category(), secondary]))
    expect(resolvePin([secondary, category()]).category).toBe('concerts')
  })

  it('falls back to the neutral pin when a listing has no category at all', () => {
    // An announcement legitimately has none. It still has to render.
    expect(resolvePin([])).toEqual(DEFAULT_PIN)
  })

  it('uses the first category when none is marked primary', () => {
    const [first, second] = [category({ is_primary: false }), category({ slug: 'film', is_primary: false })]
    expect(resolvePin([first, second]).category).toBe('concerts')
  })

  it('fills in the neutral icon and colour a category is missing', () => {
    expect(resolvePin([category({ icon: null, color: null })])).toEqual({
      icon: DEFAULT_PIN.icon, color: DEFAULT_PIN.color, category: 'concerts',
    })
  })

  it('is a pure function of the category — the same input twice is the same pin', () => {
    expect(resolvePin([category()])).toEqual(resolvePin([category()]))
  })
})
