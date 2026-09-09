import { describe, expect, it } from 'vitest'
import {
  DUPLICATE_DISTANCE_M, DUPLICATE_NAME_SIMILARITY, findDuplicates, MATCH_TIER,
  nameContains, nameSimilarity, normaliseVenueName, rankVenueMatches,
  shouldSuggestCreate, type VenueRow,
} from '../../api/author/venueMatch'
import { emptyVenue, validateVenue, type VenueInput } from '../../api/author/validate'

/**
 * The venue picker's two judgement calls (#31), tested from both sides.
 *
 * Ranking decides whether an author finds the venue that exists; the duplicate
 * thresholds decide whether they are stopped from adding a second copy of it.
 * Both are numbers somebody chose, so every threshold here is asserted just
 * inside and just outside — a test that only proves the warning fires would
 * pass with the threshold set to zero.
 */

const venue = (overrides: Partial<VenueRow> & { name: string }): VenueRow => ({
  id: `ven_${overrides.name.toLowerCase().replace(/\W+/g, '_')}`,
  slug: overrides.name.toLowerCase().replace(/\W+/g, '-'),
  area: null, city: null, address: null, latitude: null, longitude: null,
  ...overrides,
})

/** A point `metres` due north of another, for the distance threshold. */
const north = (lat: number, metres: number) => lat + metres / 111_320

describe('normalising a venue name', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(normaliseVenueName('Purple  Haze!')).toBe('purple haze')
    expect(normaliseVenueName('PURPLE-HAZE')).toBe('purple haze')
  })

  // Free, because it goes through the same slug rules the URLs do (#24).
  it('folds Devanagari onto its romanisation', () => {
    expect(normaliseVenueName('ठमेल')).toBe(normaliseVenueName('Thamel'))
  })
})

describe('search ranking', () => {
  const catalogue: VenueRow[] = [
    venue({ name: 'Purple Haze Rock Bar', area: 'Thamel', city: 'Kathmandu' }),
    venue({ name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu' }),
    venue({ name: 'Deep Purple Lounge', city: 'Kathmandu' }),
    venue({ name: 'Moksh', area: 'Jhamsikhel', city: 'Kathmandu' }),
    venue({ name: 'Lakeside Cafe', area: 'Baidam', city: 'Pokhara' }),
  ]

  it('puts the venue that exists above the ones that merely contain it', () => {
    const ranked = rankVenueMatches('Purple Haze', catalogue)
    // The acceptance criterion: search an existing venue, get it first.
    expect(ranked[0]?.name).toBe('Purple Haze')
    expect(ranked[0]?.tier).toBe(MATCH_TIER.exact)
    expect(ranked[1]?.name).toBe('Purple Haze Rock Bar')
  })

  it('ranks exact, then prefix, then a word inside, then a bare substring', () => {
    expect(rankVenueMatches('moksh', catalogue)[0]?.tier).toBe(MATCH_TIER.exact)
    expect(rankVenueMatches('purple ha', catalogue)[0]?.tier).toBe(MATCH_TIER.prefix)
    // "purple" begins a word in "Deep Purple Lounge" but does not begin the name.
    const deep = rankVenueMatches('purple', catalogue).find((v) => v.name === 'Deep Purple Lounge')
    expect(deep?.tier).toBe(MATCH_TIER.wordPrefix)
    const inside = rankVenueMatches('urple', catalogue).find((v) => v.name === 'Deep Purple Lounge')
    expect(inside?.tier).toBe(MATCH_TIER.substring)
  })

  it('offers a place-only match, but under every name match', () => {
    const ranked = rankVenueMatches('Thamel', catalogue)
    expect(ranked.every((v) => v.tier === MATCH_TIER.place)).toBe(true)
    expect(ranked.map((v) => v.name)).toContain('Purple Haze')

    const mixed = rankVenueMatches('Lakeside', [
      ...catalogue,
      venue({ name: 'Busy Bee', area: 'Lakeside', city: 'Pokhara' }),
    ])
    expect(mixed[0]?.name).toBe('Lakeside Cafe')
    expect(mixed.at(-1)?.name).toBe('Busy Bee')
  })

  it('breaks a tie with how much has actually happened at the venue', () => {
    const ranked = rankVenueMatches('haze', [
      venue({ name: 'Haze One', listing_count: 0 }),
      venue({ name: 'Haze Two', listing_count: 12 }),
    ])
    expect(ranked.map((v) => v.name)).toEqual(['Haze Two', 'Haze One'])
  })

  it('drops rows the prefilter handed over that match nothing', () => {
    expect(rankVenueMatches('kutumba', catalogue)).toEqual([])
  })

  it('stops offering to create a venue that already exists exactly', () => {
    expect(shouldSuggestCreate(rankVenueMatches('Purple Haze', catalogue))).toBe(false)
    // A partial match is not the same venue, so creating one is still legitimate.
    expect(shouldSuggestCreate(rankVenueMatches('Purple', catalogue))).toBe(true)
    expect(shouldSuggestCreate(rankVenueMatches('Kutumba', catalogue))).toBe(true)
  })
})

describe('the name similarity threshold', () => {
  it('is 0.80, with a real pair on each side of it', () => {
    // One place, written twice. This is the lowest-scoring true duplicate found
    // in real Kathmandu venue names, and it must be above the line.
    const same = nameSimilarity('Bhrikutimandap Exhibition Hall', 'Bhrikuti Mandap Exhibition Ground')
    expect(same).toBeGreaterThan(DUPLICATE_NAME_SIMILARITY)

    // Two different durbar squares. The highest-scoring false positive found,
    // and it must be below the line.
    const different = nameSimilarity('Patan Durbar Square', 'Basantapur Durbar Square')
    expect(different).toBeLessThan(DUPLICATE_NAME_SIMILARITY)
  })

  it('treats spacing and punctuation as no difference at all', () => {
    expect(nameSimilarity('Jazz Upstairs', 'Jazzupstairs')).toBe(1)
    expect(nameSimilarity('Purple Haze', 'purple haze!')).toBe(1)
  })

  it('keeps venues that merely share a word apart', () => {
    expect(nameSimilarity('House of Music', 'House of Fun')).toBeLessThan(DUPLICATE_NAME_SIMILARITY)
    expect(nameSimilarity('LOD Thamel', 'LOD Jhamsikhel')).toBeLessThan(DUPLICATE_NAME_SIMILARITY)
  })
})

describe('name containment', () => {
  it('catches the same venue with something appended, which Dice alone does not', () => {
    // 0.72 — under the threshold, and a duplicate all the same.
    expect(nameSimilarity('Purple Haze', 'Purple Haze Rock Bar'))
      .toBeLessThan(DUPLICATE_NAME_SIMILARITY)
    expect(nameContains('Purple Haze', 'Purple Haze Rock Bar')).toBe(true)
    expect(nameContains('Nepal Academy', 'Nepal Academy Hall')).toBe(true)
  })

  it('ignores the words that carry no identity', () => {
    expect(nameContains('The Yellow House', 'Yellow House')).toBe(true)
  })

  it('refuses to fire on a name made of nothing but generic words', () => {
    expect(nameContains('Hall', 'Nepal Academy Hall')).toBe(false)
    expect(nameContains('The Garden', 'Garden of Dreams')).toBe(false)
  })

  it('does not confuse two names that share only their common half', () => {
    expect(nameContains('Patan Durbar Square', 'Basantapur Durbar Square')).toBe(false)
  })
})

describe('duplicate detection', () => {
  const purpleHaze = venue({
    name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu',
    latitude: 27.7154, longitude: 85.3105,
  })

  it('warns about a venue with the same name in the same city', () => {
    const [warning] = findDuplicates(
      { name: 'purple haze', city: 'Kathmandu' }, [purpleHaze],
    )
    expect(warning?.reason).toBe('name')
    expect(warning?.name).toBe('Purple Haze')
  })

  it('does not warn across cities, where Nepali place names genuinely repeat', () => {
    expect(findDuplicates({ name: 'Lakeside', city: 'Kathmandu' },
      [venue({ name: 'Lakeside', city: 'Pokhara' })])).toEqual([])
    expect(findDuplicates({ name: 'Lakeside', city: 'Pokhara' },
      [venue({ name: 'Lakeside', city: 'Pokhara' })])).toHaveLength(1)
  })

  it('warns on either side of the 150m line and nowhere past it', () => {
    const near = {
      name: 'Somewhere Else Entirely', city: 'Kathmandu',
      latitude: north(27.7154, DUPLICATE_DISTANCE_M - 50), longitude: 85.3105,
    }
    const [warning] = findDuplicates(near, [purpleHaze])
    expect(warning?.reason).toBe('distance')
    expect(warning?.distance_m).toBeLessThan(DUPLICATE_DISTANCE_M)

    const far = { ...near, latitude: north(27.7154, DUPLICATE_DISTANCE_M + 50) }
    expect(findDuplicates(far, [purpleHaze])).toEqual([])
  })

  it('catches a misspelling the name rule misses, because the pin is the same', () => {
    // 0.67 on name — under the threshold, and the reason there are two rules.
    expect(nameSimilarity('Purple Haze', 'Purpel Haze')).toBeLessThan(DUPLICATE_NAME_SIMILARITY)
    const [warning] = findDuplicates(
      { name: 'Purpel Haze', city: 'Kathmandu', latitude: 27.7155, longitude: 85.3106 },
      [purpleHaze],
    )
    expect(warning?.reason).toBe('distance')
  })

  it('catches a venue with no coordinates at all, because the name is the same', () => {
    const [warning] = findDuplicates({ name: 'Purple Haze Rock Bar', city: 'Kathmandu' }, [purpleHaze])
    expect(warning?.reason).toBe('name')
    expect(warning?.distance_m).toBeNull()
  })

  it('says so when both signals agree, and puts that warning first', () => {
    const others = [
      venue({ name: 'Tom and Jerry Pub', city: 'Kathmandu', latitude: 27.71545, longitude: 85.31055 }),
      purpleHaze,
    ]
    const warnings = findDuplicates(
      { name: 'Purple Haze', city: 'Kathmandu', latitude: 27.7154, longitude: 85.3105 },
      others,
    )
    expect(warnings[0]?.name).toBe('Purple Haze')
    expect(warnings[0]?.reason).toBe('name_and_distance')
    expect(warnings[1]?.reason).toBe('distance')
  })

  it('leaves a genuinely new venue alone', () => {
    expect(findDuplicates(
      { name: 'Kutumba Studio', city: 'Lalitpur', latitude: 27.6766, longitude: 85.3159 },
      [purpleHaze],
    )).toEqual([])
  })
})

describe('venue input rules', () => {
  const complete = (overrides: Partial<VenueInput> = {}): Partial<VenueInput> => ({
    ...emptyVenue(),
    name: 'Purple Haze',
    city: 'Kathmandu',
    latitude: 27.7154,
    longitude: 85.3105,
    ...overrides,
  })

  const fields = (input: Partial<VenueInput>) => validateVenue(input).map((e) => e.field)

  it('accepts a venue with nothing but a name', () => {
    expect(validateVenue({ name: 'Purple Haze' })).toEqual([])
  })

  it('asks for a name, since that is what anyone will search for', () => {
    expect(fields(complete({ name: '   ' }))).toContain('name')
  })

  it('refuses half a coordinate pair', () => {
    expect(fields(complete({ longitude: null }))).toContain('latitude')
  })

  // The mistake nothing downstream would notice: 85.3N 27.7E is a valid pair
  // in the Arctic Ocean, and the pin would simply draw where nobody looks.
  it('catches a latitude and longitude entered the wrong way round', () => {
    expect(fields(complete({ latitude: 85.3105, longitude: 27.7154 }))).toContain('latitude')
  })

  it('lets the same coordinates through once the country is not Nepal', () => {
    expect(fields(complete({ latitude: 85.3105, longitude: 27.7154, country: 'NO' }))).toEqual([])
  })

  it('refuses a website that is not one, and a capacity that is not a count', () => {
    expect(fields(complete({ website_url: 'javascript:alert(1)' }))).toContain('website_url')
    expect(fields(complete({ capacity: 0 }))).toContain('capacity')
    expect(fields(complete({ capacity: 12.5 }))).toContain('capacity')
    expect(fields(complete({ capacity: 400 }))).toEqual([])
  })
})
