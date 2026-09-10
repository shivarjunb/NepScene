import type { Language } from '../i18n/strings'
import { formatBikram, toBikramSambat, toDevanagariDigits } from '../i18n/bikram'
import { clockTime, dayParts, longDate } from '../i18n/dates'
import type { Listing, Offer } from './catalog'

/**
 * Display formatting. Every listing carries its own IANA timezone, and the
 * catalogue is Nepal-wide, so times are formatted in the listing's zone rather
 * than the reader's: an event in Pokhara starts when it starts there.
 *
 * Formatting is language-aware (#46) rather than locale-guessing: the reader's
 * chosen language decides, not `navigator.language`, because a Nepali speaker
 * on an English phone has already told us which they want.
 */

/**
 * Nothing here asks `Intl` for Nepali. See app/i18n/dates.ts: a browser with a
 * trimmed ICU falls back to English silently, which would put an English date
 * under a Nepali heading on exactly the devices this feature is for. Every
 * Nepali form below is written out; English goes through `Intl`, where the
 * data is always present.
 */

export function startDay(listing: Listing, language: Language = 'en') {
  return dayParts(new Date(listing.starts_at), listing.timezone, language)
}

export function startTime(listing: Listing, language: Language = 'en'): string {
  if (listing.is_all_day) return language === 'ne' ? 'दिनभरि' : 'All day'
  return clockTime(new Date(listing.starts_at), listing.timezone, language)
}

/** "Friday 11 September 2026, 7:00 pm" — the sentence a page heading wants. */
export function startLine(listing: Listing, language: Language = 'en'): string {
  const date = longDate(new Date(listing.starts_at), listing.timezone, language)
  return listing.is_all_day ? date : `${date}, ${startTime(listing, language)}`
}

/**
 * The same moment in Bikram Sambat, or null when it falls outside the table
 * the converter carries. Shown *beside* the Gregorian date rather than instead
 * of it: a Nepali reader recognises Bhadra, and an audience that includes
 * people abroad still needs September.
 */
export function startBikram(listing: Listing, language: Language): string | null {
  const bs = toBikramSambat(new Date(listing.starts_at), listing.timezone)
  return bs ? formatBikram(bs, language) : null
}

/** "Purple Haze Rock Bar, Thamel" — the area only when it adds something. */
export function venueLine(listing: Listing): string | null {
  const venue = listing.venue
  if (!venue) return null
  const place = venue.area ?? venue.city
  return place && place !== venue.name ? `${venue.name}, ${place}` : venue.name
}

/**
 * The listing's own words, in the reader's language where it has them (#46).
 *
 * Falls back rather than blanking: a listing with an English title and no
 * Nepali one shows the English title to a Nepali reader, because a card with
 * no name on it is worse than a card in the wrong language. The `lang`
 * attribute that goes with it is what stops a screen reader reading English in
 * a Nepali voice — see `langOf`.
 */
export function titleOf(listing: { title: string; title_ne: string | null }, language: Language) {
  return language === 'ne' && listing.title_ne ? listing.title_ne : listing.title
}

export function summaryOf(
  listing: { summary: string | null; summary_ne: string | null }, language: Language,
) {
  return language === 'ne' && listing.summary_ne ? listing.summary_ne : listing.summary
}

export function descriptionOf(
  listing: { description: string | null; description_ne: string | null }, language: Language,
) {
  return language === 'ne' && listing.description_ne ? listing.description_ne : listing.description
}

/** A category's label in the reader's language, falling back to English. */
export function categoryName(
  category: { name: string; name_ne: string | null }, language: Language,
): string {
  return language === 'ne' && category.name_ne ? category.name_ne : category.name
}

/**
 * Which language a piece of content actually ended up in, for the `lang`
 * attribute. Returns undefined when it matches the page, because marking every
 * element with the language it was already in is noise in the DOM.
 */
export function langOf(translated: string | null, language: Language) {
  if (language !== 'ne') return undefined
  return translated ? undefined : 'en'
}

/**
 * The seam (docs/SCOPE.md): this reads a snapshot the catalogue was given and
 * formats it. It does not decide a price, apply a discount, or check
 * availability — `price_from` arrives as integer paisa and the only arithmetic
 * permitted is the hundred that turns paisa into rupees for display.
 */
export function offerLine(listing: Listing, language: Language = 'en'): string | null {
  if (listing.listing_type === 'free') return language === 'ne' ? 'निःशुल्क' : 'Free'
  const offer: Offer | null = listing.offer
  if (!offer) return null
  if (offer.sold_out) return language === 'ne' ? 'टिकट सकियो' : 'Sold out'
  if (offer.price_from == null) return null
  // A zero snapshot means free, and "From NPR 0" is how a catalogue tells
  // someone it does not understand its own data.
  if (offer.price_from === 0) return language === 'ne' ? 'निःशुल्क' : 'Free'
  return `${language === 'ne' ? '' : 'From '}${money(offer.price_from, offer.currency, language)}${language === 'ne' ? ' देखि' : ''}`
}

/** Paisa to a rupee string. The only arithmetic this file is allowed to do. */
export function money(paisa: number, currency: string, language: Language = 'en'): string {
  const rupees = paisa / 100
  // Grouped in English and then transliterated, rather than trusting a Nepali
  // locale to be present: the grouping is the same, only the digits differ.
  const grouped = rupees.toLocaleString('en-NP', { maximumFractionDigits: 0 })
  return `${currency} ${language === 'ne' ? toDevanagariDigits(grouped) : grouped}`
}

/** Numbers in running text, in the reader's digits. */
export function count(value: number, language: Language): string {
  return language === 'ne' ? toDevanagariDigits(value) : String(value)
}

/**
 * "2 days ago" / "today", for a price snapshot's age.
 *
 * Nepali is written out rather than passed to `Intl.RelativeTimeFormat`, for
 * the same reason dates are (app/i18n/dates.ts): a trimmed ICU falls back to
 * English silently, which would put "3 days ago" in the middle of an otherwise
 * Nepali panel.
 */
export function relativeDay(iso: string, language: Language, now = new Date()): string {
  const days = Math.round((now.getTime() - Date.parse(iso)) / 86_400_000)
  if (language !== 'ne') {
    return new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' }).format(-days, 'day')
  }
  if (days <= 0) return 'आज'
  if (days === 1) return 'हिजो'
  return `${toDevanagariDigits(days)} दिनअघि`
}

export const LISTING_TYPE_LABEL: Record<Listing['listing_type'], string | null> = {
  ticketed_internal: null,
  ticketed_external: 'Tickets elsewhere',
  free: 'Free',
  announcement: 'Announcement',
}
