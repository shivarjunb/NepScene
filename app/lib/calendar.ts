import type { ListingDetail } from './catalog'

/**
 * Add-to-calendar (#43), as an iCalendar file the browser downloads.
 *
 * **Times are written in UTC, with a `Z`.** The alternative — a local time
 * plus a `VTIMEZONE` block describing Asia/Kathmandu — is more expressive and
 * a great deal more likely to be wrong: it means shipping a copy of the tz
 * database's rules for Nepal and keeping them right. A UTC instant is the same
 * instant everywhere, and every calendar client converts it into the reader's
 * own zone on arrival, which is what "correct on iOS and Android" means in
 * practice. Nepal has not changed its offset since 1986, so nothing is lost.
 *
 * **An all-day listing is a `VALUE=DATE` event, not a midnight one.** A
 * timestamped midnight lands as "00:00–01:00" in the reader's calendar, in
 * their zone, which for a festival in Kathmandu is a Tuesday-night alarm for
 * somebody in London.
 */

const CRLF = '\r\n'
/** RFC 5545 §3.1: lines fold at 75 octets. Long descriptions hit this. */
const MAX_LINE_OCTETS = 75

const stamp = (iso: string) =>
  new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** The day after, for the exclusive end of a date-valued event. */
const nextDay = (iso: string) => new Date(Date.parse(iso) + 86_400_000).toISOString()

const dateStamp = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso))
    .replace(/-/g, '')

/** Commas, semicolons and newlines are structural in iCalendar (RFC 5545 §3.3.11). */
const escapeText = (value: string) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')

/**
 * Folding counts octets, not characters — and a Devanagari character is three
 * of them in UTF-8. Splitting on character count would produce lines over the
 * limit; splitting mid-character would produce a corrupt file. This walks the
 * encoded length and breaks between characters (#46).
 */
function fold(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= MAX_LINE_OCTETS) return line

  const out: string[] = []
  let current = ''
  let octets = 0
  // A continuation line begins with a space, which itself costs an octet.
  let limit = MAX_LINE_OCTETS
  for (const character of line) {
    const size = encoder.encode(character).length
    if (octets + size > limit) {
      out.push(current)
      current = ''
      octets = 1
      limit = MAX_LINE_OCTETS
    }
    current += character
    octets += size
  }
  out.push(current)
  return out.join(`${CRLF} `)
}

export type CalendarEvent = {
  uid: string
  title: string
  description: string | null
  location: string | null
  url: string
  startsAt: string
  endsAt: string | null
  isAllDay: boolean
  timezone: string
  /** Fixed by the caller in tests; the file must be byte-identical to compare. */
  now?: string
}

export function toICal(event: CalendarEvent): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    // The product id identifies what wrote the file; clients show it when a
    // file will not parse, which is the only time anybody reads it.
    'PRODID:-//NepScene//Catalogue//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${stamp(event.now ?? new Date().toISOString())}`,
    `SUMMARY:${escapeText(event.title)}`,
  ]

  if (event.isAllDay) {
    const start = dateStamp(event.startsAt, event.timezone)
    // DTEND is exclusive for a date-valued event, so it is always the day
    // *after* the last one. That applies to a stated end as much as to an
    // absent one: passing `ends_at` straight through makes a one-day listing
    // zero-length and a three-day festival two days long.
    const end = dateStamp(nextDay(event.endsAt ?? event.startsAt), event.timezone)
    lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`)
  } else {
    lines.push(`DTSTART:${stamp(event.startsAt)}`)
    // No end time is not the same as no end. Two hours is the convention every
    // calendar UI falls back to, and an event with no DTEND at all is rendered
    // as instantaneous.
    const end = event.endsAt ?? new Date(Date.parse(event.startsAt) + 2 * 3_600_000).toISOString()
    lines.push(`DTEND:${stamp(end)}`)
  }

  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`)
  lines.push(`URL:${event.url}`, 'END:VEVENT', 'END:VCALENDAR')

  return lines.map(fold).join(CRLF) + CRLF
}

/** The listing, as the thing a calendar wants. */
export function calendarEventFor(listing: ListingDetail, origin: string): CalendarEvent {
  const venue = listing.venue
  const location = venue
    ? [venue.name, venue.address, venue.area, venue.city].filter(Boolean).join(', ')
    : null
  return {
    // Stable per listing, so re-adding it updates the entry rather than
    // creating a second one.
    uid: `${listing.id}@nepscene`,
    title: listing.title,
    description: listing.summary ?? listing.description,
    location,
    url: `${origin}/listings/${listing.slug}`,
    startsAt: listing.starts_at,
    endsAt: listing.ends_at,
    isAllDay: listing.is_all_day,
    timezone: listing.timezone,
  }
}

/**
 * Google Calendar's template URL, for the readers whose calendar lives in a
 * browser tab rather than on the device. Offered *beside* the download rather
 * than instead of it: the file is the one that works everywhere, including
 * offline and on iOS, where the Google link opens a web page nobody wanted.
 */
export function googleCalendarUrl(event: CalendarEvent): string {
  const dates = event.isAllDay
    // Exclusive here too, for the same reason as the file above.
    ? `${dateStamp(event.startsAt, event.timezone)}/`
      + `${dateStamp(nextDay(event.endsAt ?? event.startsAt), event.timezone)}`
    : `${stamp(event.startsAt)}/`
      + `${stamp(event.endsAt ?? new Date(Date.parse(event.startsAt) + 2 * 3_600_000).toISOString())}`

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates,
    details: [event.description, event.url].filter(Boolean).join('\n\n'),
    ...(event.location ? { location: event.location } : {}),
  })
  return `https://calendar.google.com/calendar/render?${params}`
}
