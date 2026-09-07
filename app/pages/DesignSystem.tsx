import { ComponentGallery } from '../gallery/ComponentGallery'
import { TokenReference } from '../gallery/TokenReference'
import { Tabs } from '../components/Tabs'

/**
 * The design system's own reference: every token and every component in every
 * state, in whichever theme is active. It is the thing #15 and #16 are checked
 * against, and it lives at /design-system rather than at / — where it used to
 * be the only page the app could render.
 */
export function DesignSystem() {
  return (
    <div className="layout stack">
      <header>
        <h1>NepScene design system</h1>
        <p className="muted">
          Every colour, size and space in the product resolves to a token below.
          Switch the theme in the header — nothing here has a second stylesheet.
        </p>
      </header>

      <Tabs
        label="Design system"
        tabs={[
          { id: 'components', label: 'Components', content: <ComponentGallery /> },
          { id: 'tokens', label: 'Tokens', content: <TokenReference /> },
        ]}
      />
    </div>
  )
}
