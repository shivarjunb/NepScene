import { toDevanagariDigits } from './bikram'
import type { Language } from './strings'

/**
 * Gregorian dates in Nepali, without depending on the runtime having Nepali
 * locale data (#46).
 *
 * `Intl.DateTimeFormat('ne-NP')` is the obvious answer and it is not a
 * reliable one: a browser built with a trimmed ICU — which is most of the
 * Android WebViews this site will be read in — silently falls back to English
 * rather than failing, so the page renders "Thursday, October 1, 2026" beside
 * a Nepali heading and nobody notices until a reader does. Twelve month names
 * and seven weekday names are cheaper than that risk.
 *
 * Only the Nepali side is hand-built. English goes through `Intl`, where the
 * data is always present.
 */
const MONTHS_NE = [
  'जनवरी', 'फेब्रुअरी', 'मार्च', 'अप्रिल', 'मे', 'जुन',
  'जुलाई', 'अगस्ट', 'सेप्टेम्बर', 'अक्टोबर', 'नोभेम्बर', 'डिसेम्बर',
] as const

const MONTHS_SHORT_NE = [
  'जन', 'फेब', 'मार्च', 'अप्रिल', 'मे', 'जुन',
  'जुलाई', 'अग', 'सेप', 'अक्टो', 'नोभे', 'डिसे',
] as const

const WEEKDAYS_NE = ['आइतबार', 'सोमबार', 'मङ्गलबार', 'बुधबार', 'बिहिबार', 'शुक्रबार', 'शनिबार'] as const
const WEEKDAYS_SHORT_NE = ['आइत', 'सोम', 'मङ्गल', 'बुध', 'बिहि', 'शुक्र', 'शनि'] as const

/** Y/M/D/weekday/hour/minute as they read in a given zone. */
type Parts = {
  year: number; month: number; day: number
  weekday: number; hour: number; minute: number
}

function partsIn(at: Date, timeZone: string): Parts {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at)

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    formatted.find((part) => part.type === type)?.value ?? ''

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    weekday: Math.max(0, weekdays.indexOf(value('weekday'))),
    // 24-hour formatting gives "24" for midnight in some ICU builds.
    hour: Number(value('hour')) % 24,
    minute: Number(value('minute')),
  }
}

const ne = (value: number | string) => toDevanagariDigits(value)

/** "बिहिबार, १ अक्टोबर २०२६" — the long form a page heading wants. */
export function longDate(at: Date, timeZone: string, language: Language): string {
  if (language !== 'ne') {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(at)
  }
  const parts = partsIn(at, timeZone)
  return `${WEEKDAYS_NE[parts.weekday]}, ${ne(parts.day)} ${MONTHS_NE[parts.month - 1]} ${ne(parts.year)}`
}

/** The three pieces a card's date block shows separately. */
export function dayParts(at: Date, timeZone: string, language: Language) {
  if (language !== 'ne') {
    const short = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).format(at)
    return { day: short({ day: 'numeric' }), month: short({ month: 'short' }), weekday: short({ weekday: 'short' }) }
  }
  const parts = partsIn(at, timeZone)
  return {
    day: ne(parts.day),
    month: MONTHS_SHORT_NE[parts.month - 1] as string,
    weekday: WEEKDAYS_SHORT_NE[parts.weekday] as string,
  }
}

/** "७:०० बेलुका" — Nepali names the part of day rather than using am/pm. */
export function clockTime(at: Date, timeZone: string, language: Language): string {
  if (language !== 'ne') {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(at).toLowerCase()
  }
  const { hour, minute } = partsIn(at, timeZone)
  // बिहान morning, दिउँसो afternoon, बेलुका evening, राति night — the four
  // divisions Nepali actually uses, in place of a two-way am/pm split.
  const period = hour < 4 ? 'राति' : hour < 12 ? 'बिहान' : hour < 16 ? 'दिउँसो' : hour < 20 ? 'बेलुका' : 'राति'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${ne(twelve)}:${ne(String(minute).padStart(2, '0'))} ${period}`
}
