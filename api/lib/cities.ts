/**
 * The twenty Nepali cities the hero headline names (#38).
 *
 * Ported from `HeroLiveMap.tsx`'s `NEPAL_CITIES`, unchanged in content — the
 * list and its aliases were assembled against real traffic and there is
 * nothing to improve about them by guessing. What changed is where it lives:
 * WaahTickets held it inside a 509-line React component, so nothing could test
 * it and the Worker could not read it. Both surfaces resolve a city now — the
 * server from `request.cf`, the client from a browser position — and one table
 * is what stops them naming the same coordinate differently.
 *
 * The aliases are what a geo-IP provider actually returns, which is rarely the
 * city and often the district, the municipality, or the neighbourhood: a
 * Kathmandu address comes back as "Kirtipur" or "Budhanilkantha" as often as
 * "Kathmandu", and the headline should say Kathmandu for all three.
 */

import { haversineKm } from './geo'

export type NepalCity = {
  name: string
  /**
   * The Nepali name (#46). Not optional: a headline reading "Kathmandu
   * वरिपरि के-के भइरहेको छ" is half-translated, and the city is the one word
   * in that sentence a Nepali reader is most likely to know in Devanagari.
   */
  name_ne: string
  lat: number
  lng: number
  aliases: string[]
}

export const NEPAL_CITIES: NepalCity[] = [
  { name: 'Kathmandu', name_ne: 'काठमाडौं', lat: 27.7172, lng: 85.3240, aliases: ['kathmandu', 'ktm', 'thamel', 'kirtipur', 'budhanilkantha'] },
  { name: 'Lalitpur', name_ne: 'ललितपुर', lat: 27.6588, lng: 85.3247, aliases: ['lalitpur', 'patan'] },
  { name: 'Bhaktapur', name_ne: 'भक्तपुर', lat: 27.6710, lng: 85.4298, aliases: ['bhaktapur', 'bhadgaon', 'dhulikhel', 'kavre'] },
  { name: 'Pokhara', name_ne: 'पोखरा', lat: 28.2096, lng: 83.9856, aliases: ['pokhara', 'kaski', 'lekhnath'] },
  { name: 'Chitwan', name_ne: 'चितवन', lat: 27.5291, lng: 84.3542, aliases: ['chitwan', 'bharatpur', 'ratnanagar', 'narayanghat'] },
  { name: 'Sauraha', name_ne: 'सौराहा', lat: 27.5722, lng: 84.4950, aliases: ['sauraha'] },
  { name: 'Biratnagar', name_ne: 'विराटनगर', lat: 26.4525, lng: 87.2718, aliases: ['biratnagar', 'morang'] },
  { name: 'Dharan', name_ne: 'धरान', lat: 26.8120, lng: 87.2836, aliases: ['dharan', 'sunsari', 'itahari'] },
  { name: 'Damak', name_ne: 'दमक', lat: 26.6625, lng: 87.6967, aliases: ['damak', 'jhapa', 'birtamod', 'mechinagar'] },
  { name: 'Ilam', name_ne: 'इलाम', lat: 26.9125, lng: 87.9252, aliases: ['ilam'] },
  { name: 'Birgunj', name_ne: 'वीरगन्ज', lat: 27.0104, lng: 84.8771, aliases: ['birgunj', 'parsa', 'simara'] },
  { name: 'Janakpur', name_ne: 'जनकपुर', lat: 26.7288, lng: 85.9256, aliases: ['janakpur', 'dhanusha', 'jaleshwar'] },
  { name: 'Hetauda', name_ne: 'हेटौंडा', lat: 27.4167, lng: 85.0333, aliases: ['hetauda', 'makwanpur'] },
  { name: 'Butwal', name_ne: 'बुटवल', lat: 27.7006, lng: 83.4489, aliases: ['butwal', 'rupandehi', 'tilottama'] },
  { name: 'Lumbini', name_ne: 'लुम्बिनी', lat: 27.4833, lng: 83.2762, aliases: ['lumbini', 'bhairahawa', 'siddharthanagar'] },
  { name: 'Gorkha', name_ne: 'गोरखा', lat: 28.0000, lng: 84.6333, aliases: ['gorkha'] },
  { name: 'Nepalgunj', name_ne: 'नेपालगन्ज', lat: 28.0500, lng: 81.6167, aliases: ['nepalgunj', 'banke', 'kohalpur'] },
  { name: 'Dhangadhi', name_ne: 'धनगढी', lat: 28.6833, lng: 80.5833, aliases: ['dhangadhi', 'kailali', 'tikapur'] },
  { name: 'Mahendranagar', name_ne: 'महेन्द्रनगर', lat: 28.9637, lng: 80.1822, aliases: ['mahendranagar', 'kanchanpur', 'bhimdatta'] },
  { name: 'Tulsipur', name_ne: 'तुल्सीपुर', lat: 28.1306, lng: 82.2958, aliases: ['tulsipur', 'dang', 'ghorahi'] },
]

/** The default, and the map's opening centre. */
export const DEFAULT_CITY = NEPAL_CITIES[0]!

/**
 * Nepal's bounding box, generously drawn.
 *
 * The nearest-city fallback only applies inside it. Without that guard a
 * visitor in Delhi is told they are in Nepalgunj — which is the nearest
 * Nepali city to them, and a lie about where they are. Outside the box the
 * answer is the default, and the map opens on Kathmandu.
 */
export const NEPAL_BOUNDS = { south: 26.3, north: 30.5, west: 79.9, east: 88.2 }

export function inNepal(lat: number, lng: number): boolean {
  return lat >= NEPAL_BOUNDS.south && lat <= NEPAL_BOUNDS.north
    && lng >= NEPAL_BOUNDS.west && lng <= NEPAL_BOUNDS.east
}

/**
 * Name the city for a place, by what it is called and then by where it is.
 *
 * The name is tried first because it is the more specific signal: a visitor
 * whose IP resolves to "Bhadgaon" is in Bhaktapur, and no amount of
 * coordinate arithmetic gets there from a city centroid a geo-IP database
 * rounded to the district.
 *
 * Substring matching in both directions is deliberate and is what the original
 * did: "Kathmandu Metropolitan City" contains "kathmandu", and a bare "Ktm"
 * is contained by nothing but is itself an alias.
 */
export function resolveCity(name: string | null | undefined, lat: number | null, lng: number | null): NepalCity {
  const lower = (name ?? '').trim().toLowerCase()
  if (lower) {
    for (const city of NEPAL_CITIES) {
      if (city.aliases.some((alias) => lower.includes(alias) || alias.includes(lower))) return city
    }
  }

  if (lat !== null && lng !== null && inNepal(lat, lng)) return nearestCity(lat, lng)

  return DEFAULT_CITY
}

/** The closest of the twenty by great-circle distance. Never null. */
export function nearestCity(lat: number, lng: number): NepalCity {
  let nearest = DEFAULT_CITY
  let shortest = Infinity
  for (const city of NEPAL_CITIES) {
    const km = haversineKm(lat, lng, city.lat, city.lng)
    if (km < shortest) {
      shortest = km
      nearest = city
    }
  }
  return nearest
}
