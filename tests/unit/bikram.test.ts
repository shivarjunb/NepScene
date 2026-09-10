import { describe, expect, it } from 'vitest'
import {
  FIRST_BS_YEAR, LAST_BS_YEAR, formatBikram, toBikramSambat, toDevanagariDigits,
} from '../../app/i18n/bikram'

/**
 * #46's unit plan: Bikram Sambat conversion against known reference dates.
 *
 * The references are the ones a Nepali reader would check first — the new
 * year, which is the anchor everybody knows, and a date verified against Hamro
 * Patro on 2026-09-10.
 */
const at = (iso: string) => toBikramSambat(new Date(iso))

describe('Bikram Sambat conversion', () => {
  it('puts the Nepali new year on 14 April', () => {
    // 1 Baisakh 2076 is 14 April 2019 — the reference every table is checked
    // against, and the one this implementation is anchored on.
    expect(at('2019-04-14T06:00:00Z')).toEqual({ year: 2076, month: 1, day: 1 })
    expect(at('2027-04-14T06:00:00Z')).toEqual({ year: 2084, month: 1, day: 1 })
  })

  it('converts a date checked against a Nepali calendar', () => {
    // 10 September 2026 is 25 Bhadra 2083.
    expect(at('2026-09-10T06:00:00Z')).toEqual({ year: 2083, month: 5, day: 25 })
  })

  it('crosses a Gregorian new year without losing a day', () => {
    expect(at('2026-01-01T06:00:00Z')).toEqual({ year: 2082, month: 9, day: 17 })
  })

  it('reads the day in Kathmandu, not in UTC', () => {
    // 18:30 UTC is half past midnight on the 11th in Nepal (UTC+5:45), and the
    // BS date people expect is the Kathmandu one.
    expect(at('2026-09-10T12:00:00Z')?.day).toBe(25)
    expect(at('2026-09-10T18:30:00Z')?.day).toBe(26)
  })

  it('walks a year without drifting', () => {
    // Every day of BS 2083 in order: the day either advances by one or the
    // month rolls over. A wrong month length shows up here as a jump.
    let previous = at('2026-04-14T06:00:00Z')!
    for (let offset = 1; offset < 365; offset++) {
      const next = at(new Date(Date.UTC(2026, 3, 14 + offset, 6)).toISOString())!
      const rolled = next.month !== previous.month
      expect(rolled ? next.day : next.day - previous.day).toBe(1)
      previous = next
    }
  })

  it('returns null outside the published table rather than extrapolating', () => {
    // A confidently wrong date in a calendar the reader trusts is worse than
    // an honest Gregorian one.
    expect(at('1990-01-01T06:00:00Z')).toBeNull()
    expect(at('2099-01-01T06:00:00Z')).toBeNull()
  })

  it('covers the years the catalogue can hold', () => {
    expect(FIRST_BS_YEAR).toBeLessThanOrEqual(2070)
    expect(LAST_BS_YEAR).toBeGreaterThanOrEqual(2090)
  })
})

describe('Nepali numerals', () => {
  it('writes digits in Devanagari', () => {
    expect(toDevanagariDigits(2083)).toBe('२०८३')
    expect(toDevanagariDigits(0)).toBe('०')
  })

  it('formats a date in the reader’s script', () => {
    const date = { year: 2083, month: 5, day: 25 }
    expect(formatBikram(date, 'ne')).toBe('२५ भदौ २०८३')
    expect(formatBikram(date, 'en')).toBe('25 Bhadra 2083')
  })
})
