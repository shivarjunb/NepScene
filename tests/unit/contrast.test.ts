import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

// Injected by vitest.config.ts: these tests run in workerd, which has no
// filesystem, and the stylesheet is the thing under test. Read lazily —
// bindings are not populated at module evaluation time.
const css = () => env.TOKENS_CSS

/**
 * WCAG 2.1 AA, computed from the token file itself (#15, #16, #17, #19).
 *
 * The point is that this cannot drift: change a colour in tokens.css and the
 * pair it breaks is named here. Eyeballing a dark theme is how products ship
 * 3:1 body text.
 */
const AA_TEXT = 4.5      // body text
const AA_LARGE = 3.0     // large text and UI component boundaries

function block(selector: string): Record<string, string> {
  // Each theme redefines the same names; read the block that owns the theme.
  const CSS = css()
  const start = CSS.indexOf(selector)
  if (start === -1) throw new Error(`no block for ${selector}`)
  const open = CSS.indexOf('{', start)
  const end = CSS.indexOf('\n}', open)
  const tokens: Record<string, string> = {}
  for (const line of CSS.slice(open, end).split('\n')) {
    const match = /^\s*(--[a-z0-9-]+):\s*([^;]+);/.exec(line)
    if (match) tokens[match[1]!] = match[2]!.trim()
  }
  return tokens
}

const light = () => block(':root {')
const darkTheme = () => ({ ...light(), ...block(":root[data-theme='dark']") })

function resolve(theme: Record<string, string>, name: string, depth = 0): string {
  const value = theme[name]
  if (value === undefined) throw new Error(`unknown token ${name}`)
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value)
  if (reference && depth < 10) return resolve(theme, reference[1]!, depth + 1)
  return value
}

function rgb(value: string): [number, number, number] {
  const hex = value.trim()
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a plain hex colour: ${value}`)
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

/** WCAG relative luminance. */
function luminance(value: string): number {
  const [r, g, b] = rgb(value).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(theme: Record<string, string>, a: string, b: string): number {
  const [x, y] = [luminance(resolve(theme, a)), luminance(resolve(theme, b))]
  const [light, dim] = x > y ? [x, y] : [y, x]
  return (light + 0.05) / (dim + 0.05)
}

/** Pairs that actually appear together in the components. */
const TEXT_PAIRS: [string, string][] = [
  ['--text-primary', '--surface'],
  ['--text-primary', '--surface-raised'],
  ['--text-primary', '--surface-sunken'],
  ['--text-secondary', '--surface'],
  ['--text-secondary', '--surface-raised'],
  ['--text-muted', '--surface'],
  ['--text-inverse', '--surface-inverse'],
  ['--accent', '--surface'],
  ['--accent', '--surface-raised'],
  ['--accent', '--accent-surface'],
  ['--text-on-accent', '--accent'],
  ['--success', '--surface'],
  ['--success', '--success-surface'],
  ['--warning', '--surface'],
  ['--warning', '--warning-surface'],
  ['--danger', '--surface'],
  ['--danger', '--danger-surface'],
]

/**
 * WCAG 1.4.11 requires 3:1 for what identifies a control and its state — the
 * boundary of an input, a focus ring. It does not govern decorative lines, so
 * --border (dividers, card outlines) and --accent-border (a badge outline
 * beside text that already passes 4.5:1) are deliberately absent: asserting
 * them would force decoration to look like chrome.
 */
const UI_PAIRS: [string, string][] = [
  ['--border-strong', '--surface'],
  ['--border-strong', '--surface-raised'],
  ['--focus-ring', '--surface'],
  ['--focus-ring', '--surface-raised'],
]

for (const [themeName, themeOf] of [['light', light], ['dark', darkTheme]] as const) {
  describe(`${themeName} theme meets WCAG 2.1 AA`, () => {
    it.each(TEXT_PAIRS)('%s on %s reaches 4.5:1', (foreground, background) => {
      const ratio = contrast(themeOf(), foreground, background)
      expect(ratio, `${foreground} on ${background} is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA_TEXT)
    })

    it.each(UI_PAIRS)('%s on %s reaches 3:1', (foreground, background) => {
      const ratio = contrast(themeOf(), foreground, background)
      expect(ratio, `${foreground} on ${background} is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA_LARGE)
    })
  })
}

describe('the token layer holds its shape', () => {
  it('defines every semantic token in both themes', () => {
    const semantic = Object.keys(light()).filter((name) => !name.startsWith('--palette-'))
    const darkOverrides = Object.keys(block(":root[data-theme='dark']"))
    // Dark need not redefine dimensions, but every colour it does redefine
    // must already exist in light, or one theme has a token the other lacks.
    for (const name of darkOverrides) {
      expect(semantic, `${name} is defined in dark but not light`).toContain(name)
    }
  })

  it('names tokens by purpose, not appearance', () => {
    const semantic = Object.keys(light()).filter((name) => !name.startsWith('--palette-'))
    for (const name of semantic) {
      expect(name, `${name} names a colour rather than a role`)
        .not.toMatch(/--(grey|gray|slate|red|blue|green|violet|crimson|white|black)-?\d*$/)
    }
  })
})
