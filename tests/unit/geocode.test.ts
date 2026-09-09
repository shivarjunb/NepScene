import { describe, expect, it } from 'vitest'
import {
  applyPlaceToVenue, coordinateWarning, formatCoordinates, roundCoordinate,
  venueFromPlace, type AddressComponent,
} from '../../app/author/geocode'
import { emptyVenue } from '../../api/author/validate'

/**
 * #31 — the browser's half of the venue picker, minus the map.
 *
 * The Vitest suite runs in workerd and has no DOM, which is exactly why the
 * mapping from Google's answer to a venue row was written as a pure function:
 * it is the part most likely to be wrong (Google's component vocabulary is not
 * Nepal's) and the only part testable without a browser. The map itself is
 * covered in tests/e2e/venuePicker.spec.ts.
 */

const component = (long: string, types: string[], short = long): AddressComponent =>
  ({ long_name: long, short_name: short, types })

/** What Google actually returns for a Thamel address, trimmed to the fields used. */
const THAMEL = {
  formatted_address: 'Thamel Marg, Kathmandu 44600, Nepal',
  place_id: 'ChIJ_thamel',
  name: 'Purple Haze Rock Bar',
  address_components: [
    component('Thamel Marg', ['route']),
    component('Thamel', ['sublocality_level_1', 'sublocality', 'political']),
    component('Kathmandu', ['locality', 'political']),
    component('Kathmandu', ['administrative_area_level_2', 'political']),
    component('Bagmati Province', ['administrative_area_level_1', 'political']),
    component('Nepal', ['country', 'political'], 'NP'),
    component('44600', ['postal_code']),
  ],
}

describe('a place becomes a venue row', () => {
  it('maps Google’s component vocabulary onto the venue columns', () => {
    const venue = venueFromPlace(THAMEL, 27.71501, 85.31102)

    expect(venue).toMatchObject({
      name: 'Purple Haze Rock Bar',
      address: 'Thamel Marg, Kathmandu 44600, Nepal',
      area: 'Thamel',
      city: 'Kathmandu',
      district: 'Kathmandu',
      province: 'Bagmati Province',
      country: 'NP',
      latitude: 27.71501,
      longitude: 85.31102,
      google_place_id: 'ChIJ_thamel',
    })
  })

  it('takes the two-letter country code, which is what the column holds', () => {
    // `validateVenue` compares country against 'NP'; the long name would fail
    // that comparison silently and skip the outside-Nepal check with it.
    expect(venueFromPlace(THAMEL, 27.7, 85.3).country).toBe('NP')
  })

  it('falls back to the municipality where Google has no locality', () => {
    // Common outside the valley: no `locality`, but level 3 is the municipality,
    // which is what a person answers "which city?" with.
    const place = {
      formatted_address: 'Bandipur 33902, Nepal',
      address_components: [
        component('Bandipur', ['administrative_area_level_3', 'political']),
        component('Tanahun', ['administrative_area_level_2', 'political']),
        component('Nepal', ['country'], 'NP'),
      ],
    }
    expect(venueFromPlace(place, 27.936, 84.412).city).toBe('Bandipur')
  })

  it('prefers sublocality to neighbourhood, in that order', () => {
    const place = {
      address_components: [
        component('Jhamsikhel', ['neighborhood', 'political']),
        component('Sanepa', ['sublocality_level_1', 'political']),
      ],
    }
    expect(venueFromPlace(place, 27.68, 85.31).area).toBe('Sanepa')
  })

  it('leaves what Google does not know as null rather than as empty strings', () => {
    const venue = venueFromPlace({ address_components: [] }, 27.7, 85.3)
    expect(venue.area).toBeNull()
    expect(venue.city).toBeNull()
    expect(venue.address).toBeNull()
    expect(venue.google_place_id).toBeNull()
  })
})

describe('a reverse geocode does not eat the form', () => {
  const typed = {
    ...emptyVenue(),
    name: 'The Old Barn',
    phone: '+977 1 4444444',
    website_url: 'https://example.np',
    capacity: 300,
    address: null,
  }

  it('fills the place fields in', () => {
    const filled = applyPlaceToVenue(typed, THAMEL, 27.715, 85.311)
    expect(filled.address).toBe('Thamel Marg, Kathmandu 44600, Nepal')
    expect(filled.area).toBe('Thamel')
    expect(filled.city).toBe('Kathmandu')
  })

  it('never overwrites the name, phone, website or capacity', () => {
    // Google's name for the building is not the author's name for the event's
    // venue, and a pin nudged fifty metres must not discard their typing.
    const filled = applyPlaceToVenue(typed, THAMEL, 27.715, 85.311)
    expect(filled.name).toBe('The Old Barn')
    expect(filled.phone).toBe('+977 1 4444444')
    expect(filled.website_url).toBe('https://example.np')
    expect(filled.capacity).toBe(300)
  })

  it('keeps a typed address when the geocoder has nothing to say', () => {
    const withAddress = { ...typed, address: 'Behind the school, Chapagaun' }
    const filled = applyPlaceToVenue(withAddress, { address_components: [] }, 27.6, 85.3)
    expect(filled.address).toBe('Behind the school, Chapagaun')
  })

  it('always moves the coordinates, because that is what the author just did', () => {
    const filled = applyPlaceToVenue(typed, { address_components: [] }, 27.6, 85.3)
    expect(filled.latitude).toBe(27.6)
    expect(filled.longitude).toBe(85.3)
  })
})

describe('coordinate precision', () => {
  it('keeps five decimal places, which is about a metre', () => {
    // Four would be 11 m — the acceptance criterion is "within about 10 m", so
    // rounding alone would spend the entire budget.
    expect(roundCoordinate(27.7172345678)).toBe(27.71723)
    expect(formatCoordinates(27.7172, 85.324)).toBe('27.71720, 85.32400')
  })
})

describe('the warning on a pin that cannot be right', () => {
  it('says nothing about a pin inside Nepal', () => {
    expect(coordinateWarning(27.7172, 85.324)).toBeNull()
  })

  it('says nothing when there is no pin', () => {
    expect(coordinateWarning(null, null)).toBeNull()
  })

  it('names the swap, which is the mistake nothing downstream would notice', () => {
    // 85.3N 27.7E is a perfectly valid point in the Arctic Ocean.
    expect(coordinateWarning(85.324, 27.7172)).toMatch(/swapping/)
  })

  it('warns without guessing when the pin is simply elsewhere', () => {
    const message = coordinateWarning(48.8584, 2.2945)
    expect(message).toBe('That pin is outside Nepal')
  })

  it('rejects numbers that are not coordinates at all', () => {
    expect(coordinateWarning(95, 85)).toMatch(/-90 to 90/)
    expect(coordinateWarning(27.7, 200)).toMatch(/-180 to 180/)
    expect(coordinateWarning(Number.NaN, 85.3)).toBe('Those are not coordinates')
  })
})
