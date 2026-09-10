import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './shell/AppShell'
import { ThemeProvider } from './theme'
import { LanguageProvider } from './i18n'
import { Router, useRoute, useRouteFocus } from './router'
import { renderRoute, titleFor } from './routes'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/shell.css'
import './styles/author.css'
import './styles/map.css'
import './styles/public.css'

function App() {
  const path = useRoute()
  useRouteFocus(path)

  useEffect(() => { document.title = titleFor(path) }, [path])

  return <AppShell>{renderRoute(path)}</AppShell>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      {/* Language wraps the router rather than the other way round: the shell
          and every page read it, and it is state rather than a route (#46). */}
      <LanguageProvider>
        <Router>
          <App />
        </Router>
      </LanguageProvider>
    </ThemeProvider>
  </StrictMode>,
)
