import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './shell/AppShell'
import { ThemeProvider } from './theme'
import { Router, useRoute, useRouteFocus } from './router'
import { renderRoute, titleFor } from './routes'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/shell.css'
import './styles/author.css'

function App() {
  const path = useRoute()
  useRouteFocus(path)

  useEffect(() => { document.title = titleFor(path) }, [path])

  return <AppShell>{renderRoute(path)}</AppShell>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <Router>
        <App />
      </Router>
    </ThemeProvider>
  </StrictMode>,
)
