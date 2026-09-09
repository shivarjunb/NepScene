import { describe, expect, it } from 'vitest'
import {
  clearDraft, hasContent, isWorthRecovering, listLocalDrafts, loadDraft, memoryStorage,
  saveDraft, type StoredDraft,
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

describe('whether there is anything to save at all', () => {
  it('says no to an untouched form', () => {
    // An untouched form is not nothing — it is a full ListingInput of
    // defaults. Treating it as content is what made opening /submit and
    // walking away create an empty listing a second and a half later.
    expect(hasContent(emptyListing())).toBe(false)
  })

  it.each([
    ['a title', { title: 'Something' }],
    ['a start date', { starts_at: '2027-01-01T00:00:00Z' }],
    ['a summary', { summary: 'Something' }],
    ['a description', { description: 'Something' }],
    ['a venue', { venue_id: 'ven_a' }],
    ['a category', { category_slugs: ['concerts'] }],
    ['a tag', { tags: ['holi'] }],
  ])('says yes once there is %s', (_label, patch) => {
    expect(hasContent({ ...emptyListing(), ...patch })).toBe(true)
  })

  it('is not fooled by the defaults a fresh form carries', () => {
    // listing_type and timezone always have a value; neither means the author
    // has done anything.
    expect(hasContent({
      ...emptyListing(), listing_type: 'announcement', timezone: 'Asia/Kathmandu',
      is_all_day: true,
    })).toBe(false)
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

describe('listing what this device is holding (#34)', () => {
  const draftFor = (title: string): ListingInput => ({ ...emptyListing(), title })

  const seed = (entries: { key: string; draft: unknown }[]) => {
    const data = new Map<string, string>(
      entries.map(({ key, draft }) => [key, JSON.stringify(draft)]),
    )
    // `listLocalDrafts` enumerates through `globalThis.localStorage` because
    // `DraftStorage` is deliberately only the three methods the wizard needs.
    const store = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
      removeItem: (key: string) => { data.delete(key) },
    }
    Object.defineProperty(globalThis, 'localStorage', {
      value: Object.assign(Object.create(null), Object.fromEntries(data), store),
      configurable: true,
    })
    return store
  }

  it('returns every draft worth recovering, newest first', () => {
    const storage = seed([
      { key: 'nepscene:draft:new', draft: { id: null, step: 'details', savedAt: '2026-09-01T00:00:00.000Z', listing: draftFor('Older') } },
      { key: 'nepscene:draft:lst_a', draft: { id: 'lst_a', step: 'when', savedAt: '2026-09-05T00:00:00.000Z', listing: draftFor('Newer') } },
    ])

    const found = listLocalDrafts(storage, Date.parse('2026-09-06T00:00:00.000Z'))
    expect(found.map((entry) => entry.draft.listing.title)).toEqual(['Newer', 'Older'])
    expect(found.map((entry) => entry.id)).toEqual(['lst_a', null])
  })

  it('leaves out the empty ones, which are not unfinished work', () => {
    const storage = seed([
      { key: 'nepscene:draft:new', draft: { id: null, step: 'details', savedAt: '2026-09-05T00:00:00.000Z', listing: emptyListing() } },
    ])
    expect(listLocalDrafts(storage, Date.parse('2026-09-06T00:00:00.000Z'))).toEqual([])
  })

  it('leaves out the stale ones, and ignores keys that are not ours', () => {
    const storage = seed([
      { key: 'nepscene:draft:lst_old', draft: { id: 'lst_old', step: 'details', savedAt: '2026-01-01T00:00:00.000Z', listing: draftFor('Ancient') } },
      { key: 'nepscene:theme', draft: 'dark' },
    ])
    expect(listLocalDrafts(storage, Date.parse('2026-09-06T00:00:00.000Z'))).toEqual([])
  })

  it('returns nothing rather than throwing where storage is unavailable', () => {
    // Some privacy modes throw on the property access itself, and the
    // dashboard must render either way.
    Object.defineProperty(globalThis, 'localStorage', {
      get() { throw new Error('denied') },
      configurable: true,
    })
    expect(listLocalDrafts(memoryStorage())).toEqual([])
  })
})
