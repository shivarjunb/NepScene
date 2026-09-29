import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { Root } from './Root'
import { locationOf } from './router'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/shell.css'
import './styles/author.css'
import './styles/map.css'
import './styles/public.css'

const container = document.getElementById('root')!

/**
 * Hydrate what the server rendered, or mount from nothing.
 *
 * The Worker server-renders the public pages (#45) and leaves the rest to the
 * SPA fallback, so both cases are normal and the marker on the container is
 * what says which this is. Calling `hydrateRoot` on an empty container would
 * warn and rebuild; calling `createRoot` on server markup would throw it away
 * and rebuild, which is the same waste with an extra flash.
 */
const serverRendered = container.dataset.rendered === 'server'

/**
 * The language the server chose, so the first client render matches it exactly.
 * The reader's stored preference is applied immediately afterwards, in an
 * effect — see `LanguageProvider`.
 */
const language = container.dataset.language === 'ne' ? 'ne' : 'en'

/**
 * Whether that language was asked for or merely defaulted to. A link shared
 * with `?lang=ne` has to survive the browser's own preferences; a page that
 * simply defaulted to English must not.
 */
const languageExplicit = new URLSearchParams(window.location.search).has('lang')

const tree = (
  <StrictMode>
    <Root
      location={serverRendered ? locationOf(window.location.href) : undefined}
      language={serverRendered ? language : undefined}
      languageExplicit={serverRendered ? languageExplicit : undefined}
    />
  </StrictMode>
)

if (serverRendered) hydrateRoot(container, tree)
else createRoot(container).render(tree)
