import { emptyVenue, insideNepal, type VenueInput } from '../../api/author/validate'

/**
 * Turning what Google says about a place into the venue row NepScene keeps
 * (#31).
 *
 * Everything here is a pure function over a structural shape rather than over
 * `google.maps` types, for two reasons. The Vitest suite runs in workerd, where
 * there is no DOM and no Maps SDK, so a function that takes a
 * `GeocoderResult` could not be unit-tested at all; and the mapping — which of
 * Google's dozen component types is a *city* in Nepal — is the part most likely
 * to be wrong and the part a test can actually pin down.
 *
 * The geocoding call itself stays in `MapLocationPicker`, where the SDK is.
 */

/** Structurally what `google.maps.GeocoderAddressComponent` is. */
export type AddressComponent = {
  long_name: string
  short_name: string
  types: string[]
}

export type PlaceLike = {
  formatted_address?: string | null
  place_id?: string | null
  address_components?: AddressComponent[] | null
  name?: string | null
}

const componentOf = (components: AddressComponent[], ...types: string[]): AddressComponent | null => {
  // In the order asked for, not in the order Google returned: the caller's
  // list is a preference — `sublocality_level_1` before `neighborhood` — and
  // scanning the components once would hand back whichever came first instead.
  for (const type of types) {
    const found = components.find((component) => component.types.includes(type))
    if (found) return found
  }
  return null
}

const value = (component: AddressComponent | null, short = false) => {
  const text = (short ? component?.short_name : component?.long_name)?.trim()
  return text ? text : null
}

/**
 * Google's components, mapped onto the venue columns.
 *
 * The Nepali specifics, because they are not what the type names suggest:
 *
 * - **city** is `locality`. Where Google has no locality — common outside the
 *   valley — `administrative_area_level_3` is the municipality, which is the
 *   thing a person would answer "which city?" with.
 * - **area** is the neighbourhood an address is actually given by in Nepal:
 *   Thamel, Jhamsikhel, Lakeside. Google files these under `sublocality`, and
 *   sometimes only under `neighborhood`.
 * - **district** is `administrative_area_level_2`. Nepal's zones were abolished
 *   in 2015 and Google no longer returns them, so there is no level to skip.
 * - **province** is `administrative_area_level_1` ("Bagmati Province").
 * - **country** is the two-letter `short_name`, because that is what the column
 *   holds and what `validateVenue` compares against.
 */
export function venueFromPlace(place: PlaceLike, lat: number, lng: number): VenueInput {
  const components = place.address_components ?? []

  return {
    ...emptyVenue(),
    name: value({ long_name: place.name ?? '', short_name: '', types: [] }) ?? '',
    address: place.formatted_address?.trim() || null,
    area: value(componentOf(components, 'sublocality_level_1', 'sublocality', 'neighborhood')),
    city: value(componentOf(components, 'locality', 'administrative_area_level_3')),
    district: value(componentOf(components, 'administrative_area_level_2')),
    province: value(componentOf(components, 'administrative_area_level_1')),
    country: value(componentOf(components, 'country'), true)?.toUpperCase() ?? 'NP',
    latitude: lat,
    longitude: lng,
    google_place_id: place.place_id?.trim() || null,
  }
}

/**
 * The fields a reverse geocode is allowed to overwrite when the author drags
 * the pin.
 *
 * It never touches the name, the capacity, the phone or the website: those are
 * the author's typing, and a pin nudged fifty metres must not silently discard
 * them. This is the difference between "the map filled the address in for me"
 * and "the map ate my form".
 */
export function applyPlaceToVenue(venue: VenueInput, place: PlaceLike, lat: number, lng: number): VenueInput {
  const geocoded = venueFromPlace(place, lat, lng)
  return {
    ...venue,
    address: geocoded.address ?? venue.address,
    area: geocoded.area ?? venue.area,
    city: geocoded.city ?? venue.city,
    district: geocoded.district ?? venue.district,
    province: geocoded.province ?? venue.province,
    country: geocoded.country,
    latitude: lat,
    longitude: lng,
    google_place_id: geocoded.google_place_id ?? venue.google_place_id,
  }
}

/**
 * Five decimal places, which is about 1.1 m at Nepal's latitude.
 *
 * The acceptance criterion is a pin placeable to within about ten metres, and
 * four decimal places is 11 m — exactly on the line, so a rounded coordinate
 * could land outside it by itself before anybody's finger is involved. Five is
 * one character more and puts the rounding an order of magnitude inside the
 * budget. Six would be false precision: no consumer geocoder is that good.
 */
export const COORDINATE_DP = 5

export const roundCoordinate = (value: number): number =>
  Math.round(value * 10 ** COORDINATE_DP) / 10 ** COORDINATE_DP

export const formatCoordinates = (lat: number, lng: number): string =>
  `${lat.toFixed(COORDINATE_DP)}, ${lng.toFixed(COORDINATE_DP)}`

/**
 * What to say about a pin the author has just dropped, or null when there is
 * nothing to say.
 *
 * The swapped-coordinate case is the one worth catching in the browser: 85.3N
 * 27.7E is a valid pair in the Arctic Ocean, so nothing downstream objects and
 * the pin simply draws where nobody looks (api/author/validate.ts). Here the
 * author is still looking at the map, which is the only moment the mistake is
 * cheap to fix.
 */
export function coordinateWarning(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null) return null
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'Those are not coordinates'
  if (lat < -90 || lat > 90) return 'Latitude runs from -90 to 90'
  if (lng < -180 || lng > 180) return 'Longitude runs from -180 to 180'
  if (insideNepal(lat, lng)) return null
  if (insideNepal(lng, lat)) {
    return 'That pin is outside Nepal, and swapping the two numbers puts it inside — check they are the right way round'
  }
  return 'That pin is outside Nepal'
}
