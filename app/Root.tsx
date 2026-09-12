import { useEffect } from 'react'
import { AppShell } from './shell/AppShell'
import { ThemeProvider } from './theme'
import { LanguageProvider } from './i18n'
import type { Language } from './i18n/strings'
import { Router, useOverlay, useRoute, useRouteFocus } from './router'
import { renderOverlay, renderRoute, titleFor } from './routes'
import { PreloadProvider } from './lib/preloadContext'
import type { Preloaded } from './lib/preload'

/**
 * The one tree, rendered on both sides (#45).
 *
 * The server and the browser must produce identical markup or React discards
 * what was served and rebuilds the page — which would leave server rendering
 * costing a round trip and buying nothing. Sharing the component is how that is
 * guaranteed rather than maintained: there is no second implementation to drift.
 *
 * Everything that differs between the two is a prop. The location, because the
 * server has a URL and no `window`; the language, because the server has a
 * query parameter and the browser has a stored preference that it applies
 * *after* hydration, in an effect, for the same reason.
 */
export function App() {
  const path = useRoute()
  const overlay = useOverlay()
  useRouteFocus(path)

  // An effect, so it does not run on the server — where the title is set on the
  // document itself, from the same route table (api/render/page.tsx). The tab
  // names what is in front, which is the overlay when there is one.
  const shown = overlay?.path ?? path
  useEffect(() => { document.title = titleFor(shown) }, [shown])

  return (
    <>
      <AppShell>{renderRoute(path)}</AppShell>
      {/* The page stays mounted underneath: closing the dialog must return to
          the row the reader was scanning, scrolled where they left it. */}
      {overlay && renderOverlay(overlay.path)}
    </>
  )
}

export function Root({ location, language, languageExplicit, preloaded }: {
  location?: { path: string; search: string }
  language?: Language
  /** True when the URL asked for that language, rather than it being a default. */
  languageExplicit?: boolean
  /** The server's copy of this request's data; null in the browser, which
   *  takes it from the payload the server injected instead. */
  preloaded?: Preloaded | null
}) {
  return (
    <ThemeProvider>
      {/* Language wraps the router rather than the other way round: the shell
          and every page read it, and it is state rather than a route (#46). */}
      <LanguageProvider initial={language} explicit={languageExplicit}>
        <PreloadProvider value={preloaded ?? null}>
          <Router initial={location}>
            <App />
          </Router>
        </PreloadProvider>
      </LanguageProvider>
    </ThemeProvider>
  )
}
