import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * Two of #15's criteria are properties of the stylesheets themselves, so they
 * are checked rather than asserted in a review: no component CSS may carry a
 * literal colour, and no component CSS may carry a raw z-index.
 *
 * Both are how WaahTickets ended up with #ffffff 172 times and twenty
 * competing stacking values.
 */
const sheets = () => ({
  tokens: env.TOKENS_CSS,
  components: env.COMPONENTS_CSS,
  base: env.BASE_CSS,
  shell: env.SHELL_CSS,
})

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the token layer is the only place colour is written', () => {
  it.each(['components', 'base', 'shell'] as const)(
    '%s.css contains no literal hex colour',
    (name) => {
      const found = stripComments(sheets()[name]).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      expect(found, `literal colours: ${found.join(', ')}`).toEqual([])
    },
  )

  it.each(['components', 'base', 'shell'] as const)(
    '%s.css names no colour function outside a token',
    (name) => {
      // rgb()/hsl() with numbers is a literal by another spelling.
      const found = stripComments(sheets()[name]).match(/\b(rgb|rgba|hsl|hsla)\(\s*\d/g) ?? []
      expect(found, `literal colours: ${found.join(', ')}`).toEqual([])
    },
  )
})

describe('stacking order is a named scale', () => {
  it.each(['components', 'base', 'shell'] as const)(
    '%s.css uses z-index tokens, never a number',
    (name) => {
      const declarations = stripComments(sheets()[name]).match(/z-index:\s*[^;]+/g) ?? []
      const raw = declarations.filter((line) => !line.includes('var(--z-'))
      expect(raw, `raw z-index: ${raw.join(', ')}`).toEqual([])
    },
  )

  it('defines the scale in ascending order, so the names mean something', () => {
    const tokens = stripComments(sheets().tokens)
    const order = ['--z-base', '--z-raised', '--z-sticky', '--z-header',
                   '--z-dropdown', '--z-scrim', '--z-modal', '--z-toast']
    const values = order.map((name) => {
      const match = new RegExp(`${name}:\\s*(\\d+)`).exec(tokens)
      expect(match, `${name} is not defined`).not.toBeNull()
      return Number(match![1])
    })
    expect(values).toEqual([...values].sort((a, b) => a - b))
  })
})

describe('the reference page can show every token', () => {
  it('defines every token group the reference renders', () => {
    const tokens = stripComments(sheets().tokens)
    for (const name of ['--surface', '--text-primary', '--accent', '--border',
                        '--space-4', '--text-base', '--radius-md', '--shadow-md',
                        '--duration-base', '--font-sans']) {
      expect(tokens, `${name} is missing`).toContain(`${name}:`)
    }
  })
})
