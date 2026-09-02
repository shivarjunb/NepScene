import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Logo } from '../components/Logo'
import { Button } from '../components/primitives'
import { ThemeToggle } from '../theme'
import { useFocusTrap } from '../hooks/useFocusTrap'

/**
 * The application shell (#18).
 *
 * Landmarks are real elements — header, nav, main, footer — so a screen reader
 * can jump by region without being told to. The skip link is first in the
 * document because that is the only position where it does its job.
 */
const NAV = [
  { href: '/', label: 'Discover' },
  { href: '/map', label: 'Map' },
  { href: '/venues', label: 'Venues' },
  { href: '/organizers', label: 'Organizers' },
]

export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useFocusTrap(menuRef, menuOpen, () => setMenuOpen(false))

  // A menu that stays open behind a widened viewport strands focus off-screen.
  useEffect(() => {
    const query = window.matchMedia('(min-width: 48rem)')
    const onChange = (event: MediaQueryListEvent) => { if (event.matches) setMenuOpen(false) }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen])

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>

      <header className="site-header">
        <div className="layout site-header__bar">
          <a className="site-header__brand" href="/" aria-label="NepScene home">
            <Logo />
          </a>

          <nav className="site-nav" aria-label="Primary">
            <ul className="site-nav__list">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a className="site-nav__link" href={item.href}>{item.label}</a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="site-header__actions">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              className="site-header__menu-button"
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span aria-hidden="true">☰</span>
              <span className="visually-hidden">{menuOpen ? 'Close menu' : 'Open menu'}</span>
            </Button>
          </div>
        </div>

        {menuOpen && (
          <div
            ref={menuRef}
            id="mobile-menu"
            className="mobile-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            tabIndex={-1}
          >
            <nav aria-label="Primary, mobile">
              <ul className="mobile-menu__list">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <a className="mobile-menu__link" href={item.href}
                       onClick={() => setMenuOpen(false)}>{item.label}</a>
                  </li>
                ))}
              </ul>
            </nav>
            <Button variant="secondary" block onClick={() => setMenuOpen(false)}>Close</Button>
          </div>
        )}
      </header>

      <main id="main" className="site-main" tabIndex={-1}>{children}</main>

      <footer className="site-footer">
        <div className="layout site-footer__inner">
          <div>
            <Logo size={22} />
            <p className="site-footer__tagline">What&rsquo;s happening around Nepal.</p>
          </div>
          <nav aria-label="Footer">
            <ul className="site-footer__list">
              <li><a href="/about">About</a></li>
              <li><a href="/submit">Submit an event</a></li>
              <li><a href="/privacy">Privacy</a></li>
            </ul>
          </nav>
        </div>
      </footer>
    </>
  )
}
