import { describe, expect, it } from 'vitest'
import { STRINGS, type StringKey } from '../../app/i18n/strings'
import { translate } from '../../app/i18n/translate'

/**
 * #46's first unit criterion: every interface string has a Nepali translation
 * and none is missing. This is the test the one-table-two-columns shape exists
 * to make possible — a second dictionary would drift silently instead.
 */
const keys = Object.keys(STRINGS) as StringKey[]

describe('the string table', () => {
  it('has both languages for every key', () => {
    const missing = keys.filter((key) => !STRINGS[key].en || !STRINGS[key].ne)
    expect(missing).toEqual([])
  })

  it('is actually translated, not English copied across', () => {
    // Two deliberate exceptions: the language names, which are written in the
    // language they name in both columns — an English speaker looking for
    // Nepali should see "नेपाली", not "Nepali".
    const untranslated = keys.filter((key) =>
      !key.startsWith('language.') && STRINGS[key].en === STRINGS[key].ne)
    expect(untranslated).toEqual([])
  })

  it('is written in Devanagari on the Nepali side', () => {
    const notDevanagari = keys.filter((key) =>
      !key.startsWith('language.') && !/[ऀ-ॿ]/.test(STRINGS[key].ne))
    expect(notDevanagari).toEqual([])
  })

  it('keeps the placeholders of a string in both languages', () => {
    // A translation that drops `{city}` renders a sentence with a hole in it.
    const slots = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort()
    const mismatched = keys.filter((key) =>
      JSON.stringify(slots(STRINGS[key].en)) !== JSON.stringify(slots(STRINGS[key].ne)))
    expect(mismatched).toEqual([])
  })
})

describe('translate', () => {
  it('returns the string in the language asked for', () => {
    expect(translate('nav.venues', 'en')).toBe('Venues')
    expect(translate('nav.venues', 'ne')).toBe('स्थलहरू')
  })

  it('substitutes rather than concatenating, because word order differs', () => {
    // "In Kathmandu" is a preposition; "काठमाडौंमा" is a suffix on the noun.
    expect(translate('discover.inCity', 'en', { city: 'Pokhara' })).toBe('In Pokhara')
    expect(translate('discover.inCity', 'ne', { city: 'पोखरा' })).toBe('पोखरामा')
  })

  it('leaves an unknown placeholder alone rather than printing undefined', () => {
    expect(translate('discover.inCity', 'en', {})).toContain('{city}')
  })
})
