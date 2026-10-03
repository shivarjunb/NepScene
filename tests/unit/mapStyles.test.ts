import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  DARK_MAP_BACKGROUND, DARK_MAP_STYLES, DARK_TOKENS, LIGHT_MAP_BACKGROUND,
  mapThemeOptions, mix, type MapStyle,
} from '../../app/map/mapStyles'

/**
 * The dark map style (app/map/mapStyles.ts).
 *
 * What a screenshot cannot settle — the stub SDK in the browser tests draws no
 * tiles — is settled here from the style itself: that its colours are still
 * the tokens it says they are, that every label is readable against the halo
 * Google draws it with, and that the features a reader navigates by have not
 * melted into the land.
 */

const AA_TEXT = 4.5
/**
 * Roughly Google's own night style, where water sits at 1.12:1 against the
 * land. Map features are areas and lines told apart by tone and hue, not text,
 * so WCAG's ratios do not apply — but a feature that matches the land exactly
 * is a feature the dark theme has deleted.
 */
const DISTINCT = 1.1

// tokens.css, injected by vitest.config.ts: workerd has no filesystem.
function block(selector: string): Record<string, string> {
  const css = env.TOKENS_CSS
  const open = css.indexOf('{', css.indexOf(selector))
  const tokens: Record<string, string> = {}
  for (const line of css.slice(open, css.indexOf('\n}', open)).split('\n')) {
    const match = /^\s*(--[a-z0-9-]+):\s*([^;]+);/.exec(line)
    if (match) tokens[match[1]!] = match[2]!.trim()
  }
  return tokens
}

/** A token as the dark theme resolves it, following `var()` to a value. */
function darkToken(name: string): string {
  const theme = { ...block(':root {'), ...block(":root[data-theme='dark']") }
  let value = theme[name]
  for (let depth = 0; value?.startsWith('var(') && depth < 10; depth += 1) {
    value = theme[/^var\((--[a-z0-9-]+)\)$/.exec(value)![1]!]
  }
  if (value === undefined) throw new Error(`unknown token ${name}`)
  return value
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * The colour Google ends up drawing for one feature and element: every rule
 * whose selectors cover it applies, top to bottom, and the last one wins. A
 * rule for `road` covers `road.highway`; one for `geometry` covers
 * `geometry.fill`; a missing selector covers everything.
 */
function drawn(styles: MapStyle[], featureType: string, elementType: string): string {
  const covers = (rule: string | undefined, target: string) =>
    rule === undefined || rule === 'all' || target === rule || target.startsWith(`${rule}.`)
  let colour: string | undefined
  for (const rule of styles) {
    if (covers(rule.featureType, featureType) && covers(rule.elementType, elementType)) {
      colour = rule.stylers.find((styler) => styler.color)?.color ?? colour
    }
  }
  if (!colour) throw new Error(`nothing styles ${featureType} ${elementType}`)
  return colour
}

const fill = (featureType: string) => drawn(DARK_MAP_STYLES, featureType, 'geometry.fill')
const LAND = fill('landscape.natural')

describe('the dark map style', () => {
  it('mirrors tokens.css exactly, so a retuned token cannot leave the map behind', () => {
    for (const [token, value] of Object.entries(DARK_TOKENS)) {
      expect(value, token).toBe(darkToken(token))
    }
  })

  it('draws the land in the page’s own ground, and loads on it', () => {
    expect(LAND).toBe(darkToken('--surface'))
    // The ground shown before tiles arrive is the land, so tiles landing on
    // it show no seam — and in the dark theme, no white flash.
    expect(DARK_MAP_BACKGROUND).toBe(LAND)
  })

  it('keeps every label readable against the halo it is drawn with', () => {
    const labelled = [
      'administrative.locality', 'administrative.neighborhood', 'poi.business',
      'poi.park', 'road.local', 'road.arterial', 'road.highway',
      'transit.station', 'water',
    ]
    for (const feature of labelled) {
      const text = drawn(DARK_MAP_STYLES, feature, 'labels.text.fill')
      const halo = drawn(DARK_MAP_STYLES, feature, 'labels.text.stroke')
      expect(contrast(text, halo), `${feature}: ${text} on ${halo}`).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('keeps water, parks, buildings and roads distinct from the land', () => {
    for (const feature of [
      'water', 'poi.park', 'landscape.man_made', 'road.local', 'road.arterial', 'road.highway',
    ]) {
      expect(contrast(fill(feature), LAND), feature).toBeGreaterThanOrEqual(DISTINCT)
    }
    // Water is the one feature darker than the land, as it is at night.
    expect(luminance(fill('water'))).toBeLessThan(luminance(LAND))
  })

  it('keeps the road hierarchy: streets dimmer than the roads they feed, highways apart', () => {
    expect(luminance(fill('road.local'))).toBeLessThan(luminance(fill('road.arterial')))
    expect(fill('road.highway')).not.toBe(fill('road.arterial'))
    expect(fill('road.highway')).not.toBe(fill('road.local'))
  })

  it('draws boundaries, which the catch-all land rule would otherwise erase', () => {
    expect(drawn(DARK_MAP_STYLES, 'administrative.province', 'geometry.stroke')).not.toBe(LAND)
  })

  it('only recolours: nothing the light map shows is hidden in the dark one', () => {
    for (const rule of DARK_MAP_STYLES) {
      for (const styler of rule.stylers) expect(Object.keys(styler)).toEqual(['color'])
    }
  })
})

describe('mapThemeOptions', () => {
  it('gives the dark theme the dark style and ground', () => {
    expect(mapThemeOptions('dark')).toEqual({
      styles: DARK_MAP_STYLES, backgroundColor: DARK_MAP_BACKGROUND,
    })
  })

  it('leaves the light theme as Google’s own map', () => {
    expect(mapThemeOptions('light')).toEqual({
      styles: null, backgroundColor: LIGHT_MAP_BACKGROUND,
    })
  })
})

describe('mix', () => {
  it('lays one colour over another at an alpha', () => {
    expect(mix('#ffffff', '#000000', 0.5)).toBe('#808080')
    expect(mix('#7c3aed', '#141c38', 0)).toBe('#141c38')
    expect(mix('#7c3aed', '#141c38', 1)).toBe('#7c3aed')
  })
})
