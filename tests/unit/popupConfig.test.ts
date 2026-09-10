import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POPUP_FIELDS, defaultPopupConfig, isDefaultPopupConfig, parsePopupConfig,
  POPUP_FIELDS, serialisePopupConfig,
} from '../../api/author/popupConfig'
import { pinDataUri, pinSvg } from '../../app/map/pinMarker'
import { DEFAULT_PIN, resolvePin } from '../../api/catalog/pin'

/**
 * #32 — the popup configuration and the pin that is drawn beside it.
 *
 * `parsePopupConfig` is the boundary between arbitrary stored JSON and
 * something rendered on a public map, so most of this file is about what it
 * refuses. The rest is the claim the acceptance criteria turn on: that pin
 * appearance is a function of the category with nothing separate to drift.
 */

describe('reading a stored configuration', () => {
  it('gives the defaults for a listing nobody has customised', () => {
    expect(parsePopupConfig(null)).toEqual(defaultPopupConfig())
    expect(parsePopupConfig(undefined)).toEqual(defaultPopupConfig())
  })

  it('gives the defaults for anything that is not a configuration', () => {
    // A stored config is JSON written by an older wizard, and cannot be
    // trusted to be a shape this version knows.
    for (const nonsense of ['', 'not json', '{}', '[]', 42, { fields: 'no' }, { other: 1 }]) {
      expect(parsePopupConfig(nonsense)).toEqual(defaultPopupConfig())
    }
  })

  it('parses a JSON string as readily as an object, because D1 stores text', () => {
    const config = parsePopupConfig(JSON.stringify({
      fields: [{ field: 'when', label: 'Doors', visible: true }],
    }))
    expect(config.fields[0]).toEqual({ field: 'when', label: 'Doors', visible: true })
  })

  it('drops a field it does not have', () => {
    // WaahTickets rendered `field` as a key lookup, so an unknown field was a
    // blank row nobody could explain.
    const config = parsePopupConfig({
      fields: [{ field: 'price', label: 'From', visible: true }],
    })
    // Everything is still there, in the default display order — the unknown
    // one simply is not.
    expect(config.fields.map((field) => field.field))
      .toEqual(DEFAULT_POPUP_FIELDS.map((field) => field.field))
    expect(config.fields.every((field) => field.visible === false)).toBe(true)
  })

  it('keeps the author’s order and appends the rest hidden', () => {
    const config = parsePopupConfig({
      fields: [
        { field: 'offer', label: 'Tickets', visible: true },
        { field: 'when', label: 'Doors', visible: true },
      ],
    })
    expect(config.fields.map((field) => field.field))
      .toEqual(['offer', 'when', 'venue', 'summary', 'category'])
    // Appended hidden, not shown: a field added to the set later must not turn
    // itself on for every listing already in the catalogue.
    expect(config.fields.slice(2).every((field) => field.visible === false)).toBe(true)
  })

  it('keeps the first mention of a field repeated twice', () => {
    const config = parsePopupConfig({
      fields: [
        { field: 'when', label: 'First', visible: true },
        { field: 'when', label: 'Second', visible: false },
      ],
    })
    expect(config.fields.filter((field) => field.field === 'when')).toHaveLength(1)
    expect(config.fields[0]!.label).toBe('First')
  })

  it('falls back to the default label for a blank or overlong one', () => {
    const config = parsePopupConfig({
      fields: [
        { field: 'when', label: '   ', visible: true },
        { field: 'venue', label: 'x'.repeat(200), visible: true },
      ],
    })
    expect(config.fields[0]!.label).toBe('When')
    expect(config.fields[1]!.label).toBe('Where')
  })

  it('treats a missing `visible` as shown, and only `false` as hidden', () => {
    const config = parsePopupConfig({ fields: [{ field: 'when', label: 'Doors' }] })
    expect(config.fields[0]!.visible).toBe(true)
  })
})

describe('storing one back', () => {
  it('stores the defaults as nothing', () => {
    // So that "reset" is a clearing, and a later change to the defaults still
    // reaches every listing that never overrode them.
    expect(serialisePopupConfig(defaultPopupConfig())).toBeNull()
  })

  it('stores anything else as itself', () => {
    const config = defaultPopupConfig()
    config.fields[0]!.label = 'Venue'
    expect(serialisePopupConfig(config)).toEqual(config)
  })

  it('recognises the defaults reordered as not the defaults', () => {
    const config = defaultPopupConfig()
    config.fields.reverse()
    expect(isDefaultPopupConfig(config)).toBe(false)
  })

  it('round-trips: what is stored parses back to what was stored', () => {
    const config = parsePopupConfig({
      fields: [{ field: 'category', label: 'Kind', visible: true }],
    })
    expect(parsePopupConfig(serialisePopupConfig(config))).toEqual(config)
  })

  it('has a default for every field, so nothing can be unnameable', () => {
    expect(DEFAULT_POPUP_FIELDS.map((field) => field.field).sort())
      .toEqual([...POPUP_FIELDS].sort())
  })
})

describe('the pin is a function of the category', () => {
  it('takes its colour and icon from the primary category', () => {
    const pin = resolvePin([
      { slug: 'film', name: 'Film', name_ne: null, icon: 'Film', color: '#ef4444', is_primary: true },
      { slug: 'concerts', name: 'Concerts', name_ne: null, icon: 'Music', color: '#e91e63', is_primary: false },
    ])
    expect(pin).toEqual({ icon: 'Film', color: '#ef4444', category: 'film' })
  })

  it('draws the glyph the category names', () => {
    const svg = pinSvg({ icon: 'Music', color: '#e91e63', category: 'concerts' })
    expect(svg).toContain('#e91e63')
    // The Lucide `Music` glyph, not the fallback.
    expect(svg).toContain('M9 18V5l12-2v13')
  })

  it('falls back to the map pin for an icon it has no glyph for', () => {
    // A category could be seeded with any Lucide name; an unrecognised one is
    // a plain pin in the right colour, never a blank marker.
    const svg = pinSvg({ icon: 'SomethingNew', color: '#123456', category: 'x' })
    expect(svg).toContain('#123456')
    expect(svg).toContain('M20 10c0 6-8 12-8 12')
  })

  it('draws a white outline, because the tiles underneath are not ours', () => {
    // Every one of the twelve category colours is illegible against some
    // terrain without it.
    expect(pinSvg(DEFAULT_PIN)).toContain('stroke="#ffffff"')
  })

  it('is a data URI the Maps SDK can use as a marker image', () => {
    const uri = pinDataUri(DEFAULT_PIN)
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(uri.split(',')[1]!)).toBe(pinSvg(DEFAULT_PIN))
  })
})

describe('no Leaflet survived the port', () => {
  it('leaves no leaflet class name or ripple in the pin renderer', () => {
    // WaahTickets' `map-leaflet-pin`, `pin-ripple` and `pin-body` outlived
    // Leaflet by a whole migration, and the pin the author previewed was not
    // the pin the map drew — it was assembled into an HTML string that nothing
    // ever rendered.
    const svg = pinSvg(DEFAULT_PIN)
    expect(svg).not.toMatch(/leaflet|ripple|pin-body/i)
    expect(svg).not.toContain('class=')
  })
})
