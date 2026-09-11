import { useT } from '../i18n'

/**
 * The accessibility statement (#49).
 *
 * The criterion is that it is "published and accurate", and the second word is
 * the hard one. Most accessibility statements are a compliance claim written
 * before the audit — "this site conforms to WCAG 2.1 AA" — which is useless to
 * the person reading it, because the only reason to read it is that something
 * has already not worked.
 *
 * So this says what is verified, how it is verified, what is *not* verified,
 * and what is known to be missing. A reader who hits one of the gaps below
 * finds it named here rather than concluding the site is broken and leaving.
 *
 * Every claim on this page is backed by something that runs. When one stops
 * being true a test fails, and this page has to change in the same commit —
 * which is the only mechanism that keeps a statement like this honest.
 */
export function AccessibilityPage() {
  const t = useT()

  return (
    <div className="layout stack prose">
      <header className="stack stack--tight">
        <h1>{t('a11y.title')}</h1>
        <p className="text-muted">{t('a11y.lead')}</p>
      </header>

      <section className="stack stack--tight">
        <h2>{t('a11y.standardTitle')}</h2>
        <p>{t('a11y.standardBody')}</p>
      </section>

      <section className="stack stack--tight">
        <h2>{t('a11y.verifiedTitle')}</h2>
        <ul>
          <li>{t('a11y.verifiedAxe')}</li>
          <li>{t('a11y.verifiedKeyboard')}</li>
          <li>{t('a11y.verifiedContrast')}</li>
          <li>{t('a11y.verifiedMotion')}</li>
          <li>{t('a11y.verifiedFocus')}</li>
        </ul>
      </section>

      <section className="stack stack--tight">
        <h2>{t('a11y.mapTitle')}</h2>
        <p>{t('a11y.mapBody')}</p>
      </section>

      <section className="stack stack--tight">
        <h2>{t('a11y.gapsTitle')}</h2>
        <p>{t('a11y.gapsLead')}</p>
        <ul>
          <li>{t('a11y.gapScreenReader')}</li>
          <li>{t('a11y.gapNepali')}</li>
          <li>{t('a11y.gapMapCanvas')}</li>
        </ul>
      </section>

      <section className="stack stack--tight">
        <h2>{t('a11y.contactTitle')}</h2>
        <p>
          {t('a11y.contactBody')}{' '}
          <a href="https://github.com/shivarjunb/NepScene/issues/new" target="_blank" rel="noreferrer">
            {t('a11y.contactLink')}
          </a>.
        </p>
      </section>
    </div>
  )
}
