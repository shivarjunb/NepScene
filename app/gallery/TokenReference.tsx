import { Card } from '../components/primitives'

/**
 * The token reference (#15): every token rendered as itself, in whichever
 * theme is active. A swatch sheet that lists names without showing them is how
 * a token layer drifts from the CSS it claims to describe.
 */
const COLOUR_GROUPS: { title: string; tokens: string[] }[] = [
  { title: 'Surfaces', tokens: ['--surface', '--surface-raised', '--surface-sunken', '--surface-overlay', '--surface-inverse'] },
  { title: 'Text', tokens: ['--text-primary', '--text-secondary', '--text-muted', '--text-inverse', '--text-on-accent'] },
  { title: 'Accent', tokens: ['--accent', '--accent-hover', '--accent-surface', '--accent-border'] },
  { title: 'Status', tokens: ['--success', '--success-surface', '--warning', '--warning-surface', '--danger', '--danger-surface'] },
  { title: 'Lines', tokens: ['--border', '--border-strong', '--focus-ring'] },
]

const SPACING = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8']
const TYPE = ['--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-xl', '--text-2xl', '--text-3xl', '--text-4xl']
const RADII = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-full']
const SHADOWS = ['--shadow-sm', '--shadow-md', '--shadow-lg']
const LAYERS = ['--z-base', '--z-raised', '--z-sticky', '--z-header', '--z-dropdown', '--z-scrim', '--z-modal', '--z-toast']

export function TokenReference() {
  return (
    <div className="stack">
      {COLOUR_GROUPS.map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          <div className="swatches">
            {group.tokens.map((token) => (
              <div key={token} className="swatch">
                <div className="swatch__chip" style={{ background: `var(${token})` }} />
                <code>{token}</code>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section>
        <h3>Spacing</h3>
        {SPACING.map((token) => (
          <div key={token} className="ruler">
            <div className="ruler__bar" style={{ width: `var(${token})` }} />
            <code>{token}</code>
          </div>
        ))}
      </section>

      <section>
        <h3>Type scale</h3>
        {TYPE.map((token) => (
          <p key={token} style={{ fontSize: `var(${token})`, margin: 0 }}>
            {token} — काठमाडौंमा के भइरहेको छ
          </p>
        ))}
      </section>

      <section>
        <h3>Radii and elevation</h3>
        <div className="swatches">
          {RADII.map((token) => (
            <div key={token} className="swatch">
              <div className="swatch__chip swatch__chip--bordered" style={{ borderRadius: `var(${token})` }} />
              <code>{token}</code>
            </div>
          ))}
          {SHADOWS.map((token) => (
            <div key={token} className="swatch">
              <div className="swatch__chip swatch__chip--raised" style={{ boxShadow: `var(${token})` }} />
              <code>{token}</code>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3>Layers</h3>
        <Card>
          <p className="muted">
            Component CSS uses these names and never a number. WaahTickets
            accumulated twenty different z-index values with nothing saying
            which should win.
          </p>
          <ul className="layer-list">
            {LAYERS.map((token) => (
              <li key={token}><code>{token}</code></li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  )
}
