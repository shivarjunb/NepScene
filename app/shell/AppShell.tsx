import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Logo } from '../components/Logo'
import { Button } from '../components/primitives'
import { SearchBox } from '../components/SearchBox'
import { ThemeToggle } from '../theme'
import { LanguageToggle, useT } from '../i18n'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useAccount } from '../hooks/useAccount'
import { fetchQueueCount, signOut } from '../lib/author'
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
  const [accountOpen, setAccountOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)

  // What is waiting for review, for the people who review it. Read again on
  // every page change, so publishing from the console brings the badge down
  // on the way out; one indexed COUNT, and only for accounts that moderate.
  const moderates = Boolean(account?.permissions.includes('listing:moderate'))
  const [waiting, setWaiting] = useState(0)
  useEffect(() => {
    if (!moderates) { setWaiting(0); return }
    let current = true
    fetchQueueCount().then(
      (count) => { if (current) setWaiting(count.waiting) },
      () => { if (current) setWaiting(0) },
    )
    return () => { current = false }
  }, [moderates, path])

  // The account menu is a disclosure, not a dialog: it closes on Escape, on a
  // click anywhere else, and when the page changes under it.
  useEffect(() => { setAccountOpen(false) }, [path])
  useEffect(() => {
    if (!accountOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAccountOpen(false)
      accountRef.current?.querySelector<HTMLButtonElement>('.site-account__trigger')?.focus()
    }
    const onPointer = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [accountOpen])

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
  // Everything a signed-in person can reach, in one list the header's
  // account menu and the phone menu both draw from. The console is for
  // anyone who can moderate: an editor lands on the queue, an admin on the
  // overview.
  const accountLinks = account === undefined ? null : account === null
    ? [{ href: signInHref, label: t('nav.signIn') }]
    : [
        { href: '/dashboard', label: t('nav.myListings') },
        { href: '/submit', label: t('nav.addListing') },
        ...(account.permissions.includes('listing:moderate') || account.permissions.includes('user:manage')
          ? [{ href: '/admin', label: t('nav.admin') }]
          : []),
      ]
  async function handleSignOut() {
    setMenuOpen(false)
    setAccountOpen(false)
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
            {accountLinks && !account && (
              <nav className="site-account" aria-label={t('nav.account')}>
                {accountLinks.map((item) => (
                  <Link key={item.href} className="site-nav__link site-account__link" href={item.href}
                        aria-current={path === item.href ? 'page' : undefined}>
                    {item.label}
                  </Link>
                ))}
              </nav>
            )}
            {accountLinks && account && (
              <div className="site-account" ref={accountRef}>
                <button type="button" className="site-account__trigger"
                        aria-expanded={accountOpen} aria-controls="account-menu"
                        onClick={() => setAccountOpen((open) => !open)}>
                  <span className="site-account__avatar" aria-hidden="true">
                    {initials(account)}
                    {waiting > 0 && <span className="site-account__dot" />}
                  </span>
                  <span className="site-account__name">{firstName(account)}</span>
                  <span className="visually-hidden">
                    {t('nav.accountMenu')}{waiting > 0 && `, ${t('nav.waiting', { n: waiting })}`}
                  </span>
                  <svg className="site-account__chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                </button>
                {accountOpen && (
                  <nav id="account-menu" className="account-menu" aria-label={t('nav.account')}>
                    <p className="account-menu__who">
                      <span className="account-menu__name">{account.name ?? account.email}</span>
                      {account.name && <span className="account-menu__email">{account.email}</span>}
                    </p>
                    <ul className="account-menu__list">
                      {accountLinks.map((item) => (
                        <li key={item.href}>
                          <Link className="account-menu__item" href={item.href}
                                aria-current={path === item.href ? 'page' : undefined}>
                            <span className="account-menu__label">{item.label}</span>
                            {item.href === '/admin' && waiting > 0 && (
                              <span className="account-menu__count">
                                {waiting}<span className="visually-hidden"> {t('nav.waitingShort')}</span>
                              </span>
                            )}
                          </Link>
                        </li>
                      ))}
                      <li className="account-menu__rule">
                        <button type="button" className="account-menu__item account-menu__item--quiet"
                                onClick={() => void handleSignOut()}>
                          {t('nav.signOut')}
                        </button>
                      </li>
                    </ul>
                  </nav>
                )}
              </div>
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
                          onClick={() => setMenuOpen(false)}>
                      {item.label}
                      {item.href === '/admin' && waiting > 0 && (
                        <span className="account-menu__count">
                          {waiting}<span className="visually-hidden"> {t('nav.waitingShort')}</span>
                        </span>
                      )}
                    </Link>
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

/** "RS" for Ram Sharma; the first letter of the email when there is no name. */
function initials(account: { name: string | null; email: string }): string {
  const words = (account.name ?? '').trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 0 ? words.slice(0, 2).map((word) => word[0]) : [account.email[0]]
  return letters.join('').toUpperCase()
}

/** What the trigger says: a first name, or the part of the email before the @. */
function firstName(account: { name: string | null; email: string }): string {
  return account.name?.trim().split(/\s+/)[0] || account.email.split('@')[0] || account.email
}
