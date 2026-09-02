import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './shell/AppShell'
import { ComponentGallery } from './gallery/ComponentGallery'
import { TokenReference } from './gallery/TokenReference'
import { Tabs } from './components/Tabs'
import { ThemeProvider } from './theme'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/shell.css'

/**
 * Until the discovery surface lands (#41), the app renders the design system's
 * own reference: every token and every component in every state, in whichever
 * theme is active. It is the thing #15 and #16 are checked against.
 */
function App() {
  return (
    <AppShell>
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
    </AppShell>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
