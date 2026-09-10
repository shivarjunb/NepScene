/**
 * Bikram Sambat, the calendar Nepal actually runs on (#46).
 *
 * Dashain is not "in October"; it is in Ashwin. A listing page that only ever
 * says 10 September is legible to a Nepali reader but not *useful* to one, and
 * the whole point of this feature is the difference between the two.
 *
 * **Why a table and not an algorithm.** There is no arithmetic rule for it.
 * Bikram Sambat is a solar calendar whose months begin at *sankranti* — the
 * moment the sun enters a sidereal zodiac sign — so month lengths vary between
 * 29 and 32 days in a sequence that has to be observed and published, not
 * derived. Nepal's Panchanga Nirnayak Samiti publishes it; every converter in
 * existence carries the same table.
 *
 * **The range is deliberate and bounded.** BS 2070–2090 is AD 2013 to 2034 —
 * far enough back for anything this catalogue will ever hold and eleven years
 * ahead of it. Outside that window `toBikramSambat` returns null and the caller
 * falls back to the Gregorian date rather than extrapolating, because a
 * confidently wrong date in a calendar the reader trusts is worse than an
 * honest one in the calendar they do not.
 *
 * Verified against Hamro Patro on 2026-09-10: 10 September 2026 is 25 Bhadra
 * 2083, which is what the reference cases in tests/unit/bikram.test.ts assert.
 */

/** Days per month, Baisakh first, for each BS year in range. */
const MONTH_LENGTHS: Record<number, string> = {
  2070: '31,31,31,32,31,31,29,30,30,29,30,30',
  2071: '31,31,32,31,31,31,30,29,30,29,30,30',
  2072: '31,32,31,32,31,30,30,29,30,29,30,30',
  2073: '31,32,31,32,31,30,30,30,29,29,30,31',
  2074: '31,31,31,32,31,31,30,29,30,29,30,30',
  2075: '31,31,32,31,31,31,30,29,30,29,30,30',
  2076: '31,32,31,32,31,30,30,30,29,29,30,30',
  2077: '31,32,31,32,31,30,30,30,29,30,29,31',
  2078: '31,31,31,32,31,31,30,29,30,29,30,30',
  2079: '31,31,32,31,31,31,30,29,30,29,30,30',
  2080: '31,32,31,32,31,30,30,30,29,29,30,30',
  2081: '31,32,31,32,31,30,30,30,29,30,29,31',
  2082: '31,31,32,31,31,31,30,29,30,29,30,30',
  2083: '31,31,32,31,31,31,30,29,30,29,30,30',
  2084: '31,32,31,32,31,30,30,30,29,29,30,31',
  2085: '30,32,31,32,31,30,30,30,29,30,29,31',
  2086: '31,31,32,31,31,31,30,29,30,29,30,30',
  2087: '31,31,32,31,31,31,30,30,29,30,30,30',
  2088: '30,31,32,32,30,31,30,30,29,30,30,30',
  2089: '30,32,31,32,31,30,30,30,29,30,30,30',
  2090: '30,32,31,32,31,30,30,30,29,30,30,30',}

export const FIRST_BS_YEAR = 2070
export const LAST_BS_YEAR = 2090

/**
 * 1 Baisakh 2070 fell on 14 April 2013. Anchoring on the start of the table
 * rather than on the conventional 2000 BS epoch means the count never walks
 * through seventy years of data the table does not carry.
 */
const EPOCH_UTC = Date.UTC(2013, 3, 14)
const DAY_MS = 86_400_000

/** Baisakh through Chaitra, romanised as Nepal romanises them. */
export const BS_MONTHS_EN = [
  'Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra',
] as const

export const BS_MONTHS_NE = [
  'बैशाख', 'जेठ', 'असार', 'श्रावण', 'भदौ', 'आश्विन',
  'कार्तिक', 'मंसिर', 'पुष', 'माघ', 'फाल्गुन', 'चैत',
] as const

export type BikramDate = { year: number; month: number; day: number }

const lengthsFor = (year: number): number[] | null => {
  const row = MONTH_LENGTHS[year]
  return row ? row.split(',').map(Number) : null
}

/**
 * The Bikram Sambat date for a moment, read in a given zone.
 *
 * The zone matters: 10 September 23:30 in Kathmandu is 17:45 UTC on the same
 * day, but a listing at 00:30 Kathmandu is the *previous* UTC day — and the BS
 * date people expect is the Kathmandu one. Returns null outside the table.
 */
export function toBikramSambat(at: Date, timeZone = 'Asia/Kathmandu'): BikramDate | null {
  const local = calendarDay(at, timeZone)
  let remaining = Math.round((Date.UTC(local.year, local.month - 1, local.day) - EPOCH_UTC) / DAY_MS)
  if (remaining < 0) return null

  for (let year = FIRST_BS_YEAR; year <= LAST_BS_YEAR; year++) {
    const lengths = lengthsFor(year)
    if (!lengths) return null
    for (let month = 0; month < 12; month++) {
      const length = lengths[month] as number
      if (remaining < length) return { year, month: month + 1, day: remaining + 1 }
      remaining -= length
    }
  }
  return null
}

/**
 * The Gregorian year, month and day a moment falls on in a zone. Built from
 * `Intl` parts rather than from the local `Date` getters, which read the
 * machine's zone and would put a Kathmandu evening on the wrong day for
 * everyone outside Nepal.
 */
function calendarDay(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
  const [year, month, day] = parts.split('-').map(Number)
  return { year: year as number, month: month as number, day: day as number }
}

const DEVANAGARI_DIGITS = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९']

/** 2083 → २०८३. Nepali interfaces write numbers in Devanagari digits. */
export function toDevanagariDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (digit) => DEVANAGARI_DIGITS[Number(digit)] as string)
}

/** "२५ भदौ २०८३" in Nepali, "25 Bhadra 2083" in English. */
export function formatBikram(date: BikramDate, language: 'en' | 'ne'): string {
  const month = language === 'ne'
    ? BS_MONTHS_NE[date.month - 1]
    : BS_MONTHS_EN[date.month - 1]
  return language === 'ne'
    ? `${toDevanagariDigits(date.day)} ${month} ${toDevanagariDigits(date.year)}`
    : `${date.day} ${month} ${date.year}`
}
