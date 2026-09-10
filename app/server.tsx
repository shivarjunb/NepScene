import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { Root } from './Root'
import { titleFor } from './routes'
import type { Language } from './i18n/strings'

/**
 * The browser half of server rendering (#45).
 *
 * It lives in `app/` rather than in `api/` because it *is* the app: it renders
 * the same `Root` the browser mounts, from the same route table, so the markup
 * the server sends and the markup React expects on hydration cannot drift.
 * The Worker reaches it through the `#ssr` boundary (api/render/ssr.d.ts).
 *
 * `renderToString` rather than a stream: the document is assembled by
 * `HTMLRewriter` around the built shell, which needs the markup as a value.
 * The pages are small — a listing and twenty cards — and streaming would buy
 * time-to-first-byte at the cost of not being able to set a title from the
 * content, which is most of the point.
 */
export function renderApp(
  location: { path: string; search: string },
  language: Language,
  preloaded: Record<string, unknown>,
): string {
  return renderToString(
    <StrictMode>
      <Root
        location={location}
        language={language}
        // The server only ever renders a non-default language because the URL
        // asked for one, so the two are the same question here.
        languageExplicit={language === 'ne'}
        preloaded={preloaded}
      />
    </StrictMode>,
  )
}

export function titleForPath(path: string): string {
  return titleFor(path)
}
