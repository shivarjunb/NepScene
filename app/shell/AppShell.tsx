import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Logo } from '../components/Logo'
import { Button } from '../components/primitives'
import { SearchBox } from '../components/SearchBox'
import { ThemeToggle } from '../theme'
import { LanguageToggle, useT } from '../i18n'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useAccount } from '../hooks/useAccount'
import { signOut } from '../lib/author'
import { Link, navigate, useRoute } from '../router'

/**
 * The application shell (#18).
 *
 * Landmarks are real elements — header, nav, main, footer — so a screen reader
 * can jump by region without being told to. The skip link is first in the
 * document because that is the only position where it does its job.
 */
const NAV = [
  { href: '/', key: 'nav.discover' },
  { href: '/map', key: 'nav.map' },
  { href: '/venues', key: 'nav.venues' },
  { href: '/organizers', key: 'nav.organizers' },
] as const

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRoute()
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const account = useAccount()
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

  // "Sign in" remembers where you were, so /login can send you back. A
  // sign-out from a page that needed the account is sent home rather than
  // left on a page that will now refuse it.
  const signInHref = path === '/' || path === '/login' ? '/login' : `/login?next=${encodeURIComponent(path)}`
  const accountLinks = account === undefined ? null : account === null
    ? [{ href: signInHref, label: t('nav.signIn') }]
    : [{ href: '/dashboard', label: t('nav.myListings') }]
  async function handleSignOut() {
    setMenuOpen(false)
    await signOut()
    if (['/submit', '/dashboard', '/moderate', '/admin'].some((p) => path.startsWith(p))) navigate('/')
  }

  return (
    <>
      <a className="skip-link" href="#main">{t('nav.skip')}</a>

      <header className="site-header">
        <div className="layout site-header__bar">
          <Link className="site-header__brand" href="/" aria-label={t('nav.home')}>
            <Logo />
          </Link>

          {/* The search box lives in the header rather than only on /search:
              a discovery site where search is a page you have to find first is
              a site where search does not get used (#42). It is hidden below
              62rem, where the phone layout gives it the whole width of the
              /search page and the menu instead — and on /search itself, where
              the page's own box is the control and two of them side by side is
              one too many. */}
          {path !== '/search' && (
            <div className="site-header__search">
              <SearchBox />
            </div>
          )}

          <nav className="site-nav" aria-label={t('nav.primary')}>
            <ul className="site-nav__list">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    className="site-nav__link"
                    href={item.href}
                    aria-current={path === item.href ? 'page' : undefined}
                  >
                    {t(item.key)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="site-header__actions">
            {accountLinks && (
              <nav className="site-account" aria-label={t('nav.account')}>
                {accountLinks.map((item) => (
                  <Link key={item.href} className="site-nav__link site-account__link" href={item.href}
                        aria-current={path === item.href ? 'page' : undefined}>
                    {item.label}
                  </Link>
                ))}
                {account && (
                  <Button variant="ghost" size="sm" className="site-account__link"
                          onClick={() => void handleSignOut()}>
                    {t('nav.signOut')}
                  </Button>
                )}
              </nav>
            )}
            {/* Below 48rem these two go into the menu instead: with the
                brand word they are 60px wider than a 320px screen, and the
                thing pushed off the edge was the menu button itself. */}
            <div className="site-header__settings">
              <LanguageToggle />
              <ThemeToggle />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="site-header__menu-button"
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span aria-hidden="true">☰</span>
              <span className="visually-hidden">
                {menuOpen ? t('nav.menu.close') : t('nav.menu.open')}
              </span>
            </Button>
          </div>
        </div>
      </header>

      {/* A sibling of the header, not a child: the header's backdrop-filter
          would otherwise become the containing block for this fixed panel,
          squeezing it into the header's own box instead of the viewport. */}
      {menuOpen && (
        <div
          ref={menuRef}
          id="mobile-menu"
          className="mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label={t('nav.primary')}
          tabIndex={-1}
        >
          <div className="mobile-menu__search">
            <SearchBox />
          </div>
          <nav aria-label={t('nav.primary')}>
            <ul className="mobile-menu__list">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link className="mobile-menu__link" href={item.href}
                        aria-current={path === item.href ? 'page' : undefined}
                        onClick={() => setMenuOpen(false)}>{t(item.key)}</Link>
                </li>
              ))}
            </ul>
          </nav>
          {accountLinks && (
            <nav aria-label={t('nav.account')}>
              <ul className="mobile-menu__list">
                {accountLinks.map((item) => (
                  <li key={item.href}>
                    <Link className="mobile-menu__link" href={item.href}
                          aria-current={path === item.href ? 'page' : undefined}
                          onClick={() => setMenuOpen(false)}>{item.label}</Link>
                  </li>
                ))}
                {account && (
                  <li>
                    <button type="button" className="mobile-menu__link"
                            onClick={() => void handleSignOut()}>
                      {t('nav.signOut')}
                    </button>
                  </li>
                )}
              </ul>
            </nav>
          )}
          <div className="mobile-menu__settings">
            <LanguageToggle />
            <ThemeToggle />
          </div>
          <Button variant="secondary" block onClick={() => setMenuOpen(false)}>
            {t('nav.close')}
          </Button>
        </div>
      )}

      <main id="main" className="site-main" tabIndex={-1}>{children}</main>

      <footer className="site-footer">
        <div className="layout site-footer__inner">
          <div>
            <Logo size={22} />
            <p className="site-footer__tagline">{t('footer.tagline')}</p>
          </div>
          <nav aria-label={t('footer.label')}>
            <ul className="site-footer__list">
              <li><Link href="/about">{t('footer.about')}</Link></li>
              <li><Link href="/venues">{t('nav.venues')}</Link></li>
              <li><Link href="/organizers">{t('nav.organizers')}</Link></li>
              <li><Link href="/submit">{t('footer.submit')}</Link></li>
              <li><Link href="/dashboard">{t('footer.dashboard')}</Link></li>
              <li><Link href="/privacy">{t('footer.privacy')}</Link></li>
              <li><Link href="/accessibility">{t('footer.accessibility')}</Link></li>
              <li><Link href="/design-system">{t('footer.designSystem')}</Link></li>
            </ul>
          </nav>
        </div>
      </footer>
    </>
  )
}
