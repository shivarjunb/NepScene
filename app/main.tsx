import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * Placeholder shell. The real app shell, design tokens and theming are M0
 * (#15–#18) and the discovery surface is M3/M4 — this exists so the Worker has
 * assets to serve and `npm run build` means something in CI.
 */
function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem 1.5rem', maxWidth: 640 }}>
      <h1 style={{ margin: 0 }}>NepScene</h1>
      <p>What&rsquo;s happening around Nepal.</p>
      <p>
        The catalogue is live at <code>/api/catalog/listings</code>. The site itself lands with
        the design system (#15&ndash;#18) and the map (#36).
      </p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
