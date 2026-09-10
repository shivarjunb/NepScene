import { describe, expect, it } from 'vitest'
import type { ListingDetail } from '../../app/lib/catalog'
import { calendarEventFor, googleCalendarUrl, toICal } from '../../app/lib/calendar'
import { directionsUrl, shareTargets } from '../../app/lib/share'

/**
 * #43's unit plan: a calendar export that produces valid iCal with the right
 * instant, and share targets that carry the listing rather than the page the
 * reader happens to be on.
 */
const base = {
  uid: 'lst_1@nepscene',
  title: 'Rock Night',
  description: 'A quartet, twice through.',
  location: 'Purple Haze, Thamel, Kathmandu',
  url: 'https://nepscene.test/listings/rock-night',
  startsAt: '2026-09-11T13:15:00.000Z',
  endsAt: null,
  isAllDay: false,
  timezone: 'Asia/Kathmandu',
  now: '2026-09-10T06:00:00.000Z',
}

const lines = (ical: string) => ical.split('\r\n')

describe('iCalendar export', () => {
  it('is a well-formed VCALENDAR with CRLF line endings', () => {
    const ical = toICal(base)
    expect(ical.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ical.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(lines(ical)).toContain('VERSION:2.0')
    expect(lines(ical)).toContain('BEGIN:VEVENT')
  })

  it('writes the instant in UTC, so every client converts it correctly', () => {
    // 13:15Z is 19:00 in Kathmandu. Writing the local time without a VTIMEZONE
    // would put the event at 19:00 in the reader's own zone instead.
    expect(lines(toICal(base))).toContain('DTSTART:20260911T131500Z')
  })

  it('gives an event with no stated end a sensible one rather than none', () => {
    // A VEVENT with no DTEND renders as instantaneous in most clients.
    expect(lines(toICal(base))).toContain('DTEND:20260911T151500Z')
  })

  it('uses the stated end when there is one', () => {
    expect(lines(toICal({ ...base, endsAt: '2026-09-11T18:00:00.000Z' })))
      .toContain('DTEND:20260911T180000Z')
  })

  it('writes an all-day listing as a date, in Kathmandu’s day', () => {
    const ical = toICal({ ...base, isAllDay: true, startsAt: '2026-09-11T18:30:00.000Z' })
    // 18:30Z is already the 12th in Nepal; a UTC reading would say the 11th.
    expect(lines(ical)).toContain('DTSTART;VALUE=DATE:20260912')
    // DTEND is exclusive for a date event, so a one-day event ends the day after.
    expect(lines(ical)).toContain('DTEND;VALUE=DATE:20260913')
  })

  it('makes an all-day end exclusive too, not the last day itself', () => {
    // A festival that runs the 11th to the 13th ends, in iCalendar, on the
    // 14th. Passing `ends_at` through unchanged loses the last day — and for a
    // single-day listing with an end it produces DTSTART == DTEND, which most
    // clients drop entirely.
    const festival = toICal({
      ...base, isAllDay: true,
      startsAt: '2026-09-11T00:00:00.000Z', endsAt: '2026-09-13T00:00:00.000Z',
    })
    expect(lines(festival)).toContain('DTSTART;VALUE=DATE:20260911')
    expect(lines(festival)).toContain('DTEND;VALUE=DATE:20260914')

    const oneDay = toICal({
      ...base, isAllDay: true,
      startsAt: '2026-09-11T00:00:00.000Z', endsAt: '2026-09-11T00:00:00.000Z',
    })
    expect(lines(oneDay)).toContain('DTEND;VALUE=DATE:20260912')
  })

  it('escapes the characters that are structural in iCalendar', () => {
    const ical = toICal({ ...base, title: 'Jazz, blues; and soul\nlate' })
    const summary = lines(ical).find((line) => line.startsWith('SUMMARY:'))
    expect(summary).toBe(String.raw`SUMMARY:Jazz\, blues\; and soul\nlate`)
  })

  it('folds long lines by octet, not by character', () => {
    // Devanagari is three octets per character in UTF-8; folding on character
    // count would leave lines over the 75-octet limit.
    const ical = toICal({ ...base, title: 'सङ्गीत '.repeat(20).trim() })
    const encoder = new TextEncoder()
    for (const line of lines(ical)) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(76)
    }
  })

  it('keeps a stable UID, so re-adding updates rather than duplicating', () => {
    expect(lines(toICal(base))).toContain('UID:lst_1@nepscene')
  })
})

const listing = {
  id: 'lst_1',
  slug: 'rock-night',
  title: 'Rock Night',
  summary: 'A quartet, twice through.',
  description: null,
  starts_at: base.startsAt,
  ends_at: null,
  is_all_day: false,
  timezone: 'Asia/Kathmandu',
  venue: {
    id: 'v', slug: 'purple-haze', name: 'Purple Haze', area: 'Thamel',
    city: 'Kathmandu', address: 'Bhagwan Bahal', district: null, province: null,
    latitude: 27.7154, longitude: 85.3105,
  },
} as unknown as ListingDetail

describe('the event a listing becomes', () => {
  it('addresses itself by its canonical URL', () => {
    expect(calendarEventFor(listing, 'https://nepscene.test').url)
      .toBe('https://nepscene.test/listings/rock-night')
  })

  it('builds a location a maps app can find', () => {
    expect(calendarEventFor(listing, 'https://nepscene.test').location)
      .toBe('Purple Haze, Bhagwan Bahal, Thamel, Kathmandu')
  })

  it('offers a Google Calendar link with the same instant', () => {
    const url = googleCalendarUrl(calendarEventFor(listing, 'https://nepscene.test'))
    expect(url).toContain('dates=20260911T131500Z%2F20260911T151500Z')
  })

  it('makes the Google link’s all-day end exclusive, like the file’s', () => {
    const url = googleCalendarUrl({
      ...base, isAllDay: true,
      startsAt: '2026-09-11T00:00:00.000Z', endsAt: '2026-09-13T00:00:00.000Z',
    })
    expect(url).toContain('dates=20260911%2F20260914')
  })
})

describe('sharing', () => {
  const targets = shareTargets('https://nepscene.test/listings/rock-night', 'Rock Night')

  it('puts WhatsApp first, because that is how a link travels in Nepal', () => {
    expect(targets[0]?.id).toBe('whatsapp')
  })

  it('sends the title and the link together, not the link alone', () => {
    expect(targets[0]?.href).toContain(encodeURIComponent('Rock Night — https://nepscene.test'))
  })

  it('uses the https form, which works with or without the app installed', () => {
    expect(targets[0]?.href?.startsWith('https://api.whatsapp.com/')).toBe(true)
  })

  it('offers a copy target with no href, because it is a button', () => {
    expect(targets.find((target) => target.id === 'copy')?.href).toBeUndefined()
  })
})

describe('directions', () => {
  it('prefers the place id, which opens the venue’s own card', () => {
    expect(directionsUrl({
      name: 'Purple Haze', address: null, latitude: 27.7, longitude: 85.3,
      google_place_id: 'ChIJabc',
    })).toContain('query_place_id=ChIJabc')
  })

  it('falls back to coordinates, then to the written address', () => {
    expect(directionsUrl({
      name: 'Purple Haze', address: 'Thamel', latitude: 27.7154, longitude: 85.3105,
    })).toContain('query=27.7154%2C85.3105')

    expect(directionsUrl({ name: 'Purple Haze', address: 'Thamel', latitude: null, longitude: null }))
      .toContain(encodeURIComponent('Purple Haze, Thamel'))
  })
})
