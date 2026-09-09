import { describe, expect, it } from 'vitest'
import {
  clearDraft, isWorthRecovering, loadDraft, memoryStorage, saveDraft, type StoredDraft,
} from '../../app/author/draftStore'
import { emptyListing, type ListingInput } from '../../api/author/validate'

const listing = (overrides: Partial<ListingInput> = {}): ListingInput => ({
  ...emptyListing(),
  title: 'Kutumba at Patan Durbar',
  summary: 'An evening of folk instrumental',
  starts_at: '2026-11-02T12:00:00Z',
  venue_id: 'ven_patan',
  category_slugs: ['concerts'],
  primary_category_slug: 'concerts',
  tags: ['Live Music'],
  ...overrides,
})

const draft = (overrides: Partial<StoredDraft> = {}): StoredDraft => ({
  id: null,
  listing: listing(),
  step: 'details',
  savedAt: new Date().toISOString(),
  ...overrides,
})

describe('round-tripping a draft', () => {
  it('gives back exactly what was put in', () => {
    const storage = memoryStorage()
    const original = draft()
    saveDraft(storage, original)
    expect(loadDraft(storage, null)).toEqual(original)
  })

  it('keeps drafts for different listings apart', () => {
    const storage = memoryStorage()
    saveDraft(storage, draft({ id: 'lst_a', listing: listing({ title: 'A' }) }))
    saveDraft(storage, draft({ id: 'lst_b', listing: listing({ title: 'B' }) }))

    expect(loadDraft(storage, 'lst_a')?.listing.title).toBe('A')
    expect(loadDraft(storage, 'lst_b')?.listing.title).toBe('B')
    // An unsaved new listing is its own slot, not either of those.
    expect(loadDraft(storage, null)).toBeNull()
  })

  it('survives every field being at its emptiest', () => {
    const storage = memoryStorage()
    const original = draft({ listing: emptyListing() })
    saveDraft(storage, original)
    expect(loadDraft(storage, null)).toEqual(original)
  })

  it('forgets a draft that has been cleared', () => {
    const storage = memoryStorage()
    saveDraft(storage, draft({ id: 'lst_a' }))
    clearDraft(storage, 'lst_a')
    expect(loadDraft(storage, 'lst_a')).toBeNull()
  })
})

describe('reading back something that is not a draft', () => {
  const unusable = ['', 'not json at all', 'null', '[]', '"a string"', '{"savedAt":"nonsense"}']

  it.each(unusable)('returns null rather than throwing for %j', (raw) => {
    const storage = memoryStorage()
    storage.setItem('nepscene:draft:new', raw)
    expect(loadDraft(storage, null)).toBeNull()
  })

  it('fills in a field that did not exist when the draft was written', () => {
    // The stored string outlives the version of the wizard that wrote it, so a
    // draft missing half its keys has to open rather than crash the form.
    const storage = memoryStorage()
    storage.setItem('nepscene:draft:new', JSON.stringify({
      id: null, step: 'details', savedAt: new Date().toISOString(),
      listing: { title: 'Half a draft' },
    }))

    const loaded = loadDraft(storage, null)
    expect(loaded?.listing.title).toBe('Half a draft')
    expect(loaded?.listing.timezone).toBe('Asia/Kathmandu')
    expect(loaded?.listing.category_slugs).toEqual([])
    expect(loaded?.listing.listing_type).toBe('free')
  })

  it('drops values stored at the wrong type instead of restoring them', () => {
    const storage = memoryStorage()
    storage.setItem('nepscene:draft:new', JSON.stringify({
      id: null, step: 'details', savedAt: new Date().toISOString(),
      listing: {
        title: 42, listing_type: 'gambling', category_slugs: 'concerts',
        location_lat: 'north', tags: ['ok', 7],
      },
    }))

    const loaded = loadDraft(storage, null)
    expect(loaded?.listing.title).toBe('')
    expect(loaded?.listing.listing_type).toBe('free')
    expect(loaded?.listing.category_slugs).toEqual([])
    expect(loaded?.listing.location_lat).toBeNull()
    expect(loaded?.listing.tags).toEqual(['ok'])
  })
})

describe('a draft nobody came back for', () => {
  it('is dropped once it is a fortnight old', () => {
    const storage = memoryStorage()
    const savedAt = new Date('2026-01-01T00:00:00Z').toISOString()
    saveDraft(storage, draft({ savedAt }))

    const thirteenDaysLater = Date.parse(savedAt) + 13 * 86_400_000
    expect(loadDraft(storage, null, thirteenDaysLater)).not.toBeNull()

    const fifteenDaysLater = Date.parse(savedAt) + 15 * 86_400_000
    expect(loadDraft(storage, null, fifteenDaysLater)).toBeNull()
    // And it is gone, not merely hidden.
    expect(storage.getItem('nepscene:draft:new')).toBeNull()
  })
})

describe('whether a recovered draft is worth interrupting for', () => {
  it('says no to a form nobody has typed in', () => {
    // The wizard autosaves the moment it opens. Offering to recover *that*
    // teaches people to dismiss the prompt without reading it.
    expect(isWorthRecovering(draft({ listing: emptyListing() }))).toBe(false)
  })

  it('says no to whitespace', () => {
    expect(isWorthRecovering(draft({ listing: { ...emptyListing(), title: '   ' } }))).toBe(false)
  })

  it.each([
    ['a title', { title: 'Something' }],
    ['a summary', { summary: 'Something' }],
    ['a venue', { venue_id: 'ven_a' }],
    ['a category', { category_slugs: ['concerts'] }],
    ['a tag', { tags: ['holi'] }],
  ])('says yes once there is %s', (_label, patch) => {
    expect(isWorthRecovering(draft({ listing: { ...emptyListing(), ...patch } }))).toBe(true)
  })
})

describe('storage that fights back', () => {
  it('does not take the wizard down when writing throws', () => {
    // Safari in a private window throws on setItem rather than returning. An
    // uncaught throw here would kill the form on a keystroke.
    const hostile = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(() => saveDraft(hostile, draft())).not.toThrow()
    expect(() => clearDraft(hostile, null)).not.toThrow()
    expect(loadDraft(hostile, null)).toBeNull()
  })
})
