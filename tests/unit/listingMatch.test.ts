import { describe, expect, it } from 'vitest'
import {
  DUPLICATE_THRESHOLD, findDuplicateListing, placeScore, scoreDuplicate,
  timeScore, titleScore, type ListingCandidate,
} from '../../api/author/listingMatch'

/**
 * #33 — duplicate detection at submission.
 *
 * These are the cases the weights exist to get right. The thresholds in
 * `listingMatch.ts` are reasoned rather than measured — there is no corpus of
 * known-duplicate Nepali listings yet — so this file is the calibration: if a
 * weight changes, one of these breaks, and the argument has to be made again.
 */

const PATAN = 'ven_patan'

const listing = (over: Partial<ListingCandidate> = {}): ListingCandidate => ({
  id: 'lst_a', slug: 'a', title: 'Kutumba Live', status: 'published',
  starts_at: '2027-03-14T13:00:00Z', venue_id: PATAN,
  latitude: 27.6727, longitude: 85.3250,
  ...over,
})

describe('the cases that must flag', () => {
  it('flags the same event submitted twice with the title reworded', () => {
    // The weakest thing that must still flag: title 0.8, same day, same venue.
    const scored = scoreDuplicate(
      listing({ id: 'lst_b', title: 'Kutumba Live in Concert' }),
      listing(),
    )
    expect(scored.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD)
  })

  it('flags the same festival whose second submitter invented their own venue', () => {
    // Different venue id, pin ten metres away — which is exactly what happens
    // when someone cannot find the venue and adds a copy of it (#31).
    const scored = scoreDuplicate(
      listing({ id: 'lst_b', venue_id: 'ven_duplicate', latitude: 27.6728, longitude: 85.3251 }),
      listing(),
    )
    expect(scored.signals.place).toBe(1)
    expect(scored.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD)
  })

  it('flags a submission that has not chosen a venue yet', () => {
    // Absent evidence is not counter-evidence: an incomplete submission of the
    // same event on the same day is still the same event.
    const scored = scoreDuplicate(
      listing({ id: 'lst_b', venue_id: null, latitude: null, longitude: null }),
      listing({ venue_id: null, latitude: null, longitude: null }),
    )
    expect(scored.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD)
  })

  it('flags a multi-day festival entered on two different days of its run', () => {
    const scored = scoreDuplicate(
      listing({ id: 'lst_b', title: 'Indra Jatra', starts_at: '2027-09-16T04:00:00Z' }),
      listing({ title: 'Indra Jatra', starts_at: '2027-09-14T04:00:00Z' }),
    )
    // Title 1.0 and place 1.0 carry it; the date is only worth 0.3 here.
    expect(scored.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD)
  })
})

describe('the cases that must not flag', () => {
  it('does not flag a weekly residency against last week', () => {
    // The strongest thing that must not flag: identical title, identical
    // venue, seven days apart. Flagging this teaches editors to dismiss
    // warnings without reading them, which costs more than not warning.
    const scored = scoreDuplicate(
      listing({ id: 'lst_b', title: 'Open Mic Night', starts_at: '2027-03-21T13:00:00Z' }),
      listing({ title: 'Open Mic Night' }),
    )
    expect(scored.score).toBeLessThan(DUPLICATE_THRESHOLD)
  })

  it('does not flag two different gigs at one venue on one night', () => {
    const scored = scoreDuplicate(
      listing({ id: 'lst_b', title: 'Night Shift DJ Set' }),
      listing({ title: 'Kutumba Live' }),
    )
    expect(scored.score).toBeLessThan(DUPLICATE_THRESHOLD)
  })

  it('does not flag the same tribute night in two different cities', () => {
    // Identical title at an identical hour scores 0.80 on those two signals
    // alone. A place that is definitively elsewhere has to be able to veto,
    // or Kathmandu and Pokhara become one gig.
    const scored = scoreDuplicate(
      listing({ id: 'lst_b', venue_id: 'ven_pokhara', latitude: 28.2096, longitude: 83.9856 }),
      listing(),
    )
    expect(scored.signals.place).toBe(0)
    expect(scored.score).toBeLessThan(DUPLICATE_THRESHOLD)
  })
})

describe('the signals on their own', () => {
  it('scores a title contained in another as certain', () => {
    // Dice alone puts this at 0.72, below any line that also rejects two
    // different durbar squares — which is why containment is a separate test.
    expect(titleScore('Kutumba Live', 'Kutumba Live in Concert')).toBe(1)
  })

  it('scores unrelated titles low', () => {
    expect(titleScore('Kutumba Live', 'Ghazal Evening')).toBeLessThan(0.4)
  })

  it('reads “the same day” in Kathmandu, not in UTC', () => {
    // 19:00 and 22:00 Nepal time on 14 March are 13:15 and 16:15 UTC — three
    // hours apart, so not the same moment, but the same evening.
    expect(timeScore('2027-03-14T13:15:00Z', '2027-03-14T16:15:00Z')).toBe(0.7)
    // 23:30 Nepal on the 14th is 17:45 UTC; 00:30 Nepal on the 15th is 18:45
    // UTC. A UTC reading calls those different days; they are one night out.
    expect(timeScore('2027-03-14T17:45:00Z', '2027-03-14T18:45:00Z')).toBe(1)
  })

  it('treats an unset start as no evidence rather than as a mismatch', () => {
    expect(timeScore(null, '2027-03-14T13:00:00Z')).toBe(0.5)
    expect(timeScore('not a date', '2027-03-14T13:00:00Z')).toBe(0.5)
  })

  it('scores distance in three bands, not as a curve', () => {
    const here = listing({ venue_id: null, latitude: 27.7172, longitude: 85.3240 })
    const metresAway = listing({ id: 'b', venue_id: null, latitude: 27.7176, longitude: 85.3243 })
    const acrossTown = listing({ id: 'c', venue_id: null, latitude: 27.7220, longitude: 85.3270 })
    const anotherCity = listing({ id: 'd', venue_id: null, latitude: 28.2096, longitude: 83.9856 })

    expect(placeScore(here, metresAway)).toBe(1)
    expect(placeScore(here, acrossTown)).toBe(0.5)
    expect(placeScore(here, anotherCity)).toBe(0)
  })
})

describe('choosing which duplicate to name', () => {
  it('returns nothing when nothing is close enough', () => {
    expect(findDuplicateListing(listing({ id: 'lst_new' }), [
      listing({ id: 'lst_other', title: 'Something Else', starts_at: '2028-01-01T00:00:00Z' }),
    ])).toBeNull()
  })

  it('never matches a listing against itself', () => {
    expect(findDuplicateListing(listing(), [listing()])).toBeNull()
  })

  it('prefers the published listing when two score the same', () => {
    // A published listing has a URL people may already be holding, so it is
    // the better thing to merge into than another submission still waiting.
    const found = findDuplicateListing(listing({ id: 'lst_new' }), [
      listing({ id: 'lst_pending', status: 'pending_review' }),
      listing({ id: 'lst_live', status: 'published' }),
    ])
    expect(found?.id).toBe('lst_live')
  })

  it('prefers the higher score over the published one', () => {
    // Same title and venue in both; the published one is two days out, which
    // costs it the time signal. Being published breaks ties, it does not win
    // arguments.
    const found = findDuplicateListing(listing({ id: 'lst_new' }), [
      listing({ id: 'lst_exact', status: 'pending_review' }),
      listing({ id: 'lst_loose', status: 'published', starts_at: '2027-03-16T13:00:00Z' }),
    ])
    expect(found?.id).toBe('lst_exact')
  })
})
