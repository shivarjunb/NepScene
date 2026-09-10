import { createContext, useCallback, useContext, useEffect, useMemo, useState,
         type ReactNode } from 'react'
import type { Language, StringKey } from './strings'
import { translate } from './translate'

/**
 * The translation layer (#46).
 *
 * **Language is state, not a route.** No `/ne/` prefix and no `?lang=`: a
 * switch that navigated would throw away the filters, the scroll position and
 * the search the reader is in the middle of, which is precisely what #46's
 * acceptance criteria forbid. It re-renders in place and the URL is untouched,
 * so a link shared from a Nepali session opens in whatever language the
 * recipient reads — which is the right behaviour, because the URL identifies a
 * listing, not a translation of one.
 *
 * The trade is that language is invisible to a crawler, so the served HTML is
 * the English one. That is #45's problem to solve (multilingual metadata is in
 * its scope) and it is stated here so it is a decision rather than a surprise.
 *
 * **The choice persists and the document says so.** `<html lang>` is updated
 * on every change: it is what tells a screen reader which voice to use, and
 * Devanagari read out in an English voice is unintelligible rather than merely
 * accented.
 */
const STORAGE_KEY = 'nepscene-language'

type LanguageState = {
  language: Language
  setLanguage: (next: Language) => void
}

const LanguageContext = createContext<LanguageState>({ language: 'en', setLanguage: () => {} })

export const readStoredLanguage = (): Language | null => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'ne') return stored
  } catch {
    // Storage can be unavailable — a private window, or storage disabled.
  }
  return null
}

const read = (): Language => {
  const stored = readStoredLanguage()
  if (stored) return stored
  // An explicit choice wins, but a browser that asks for Nepali gets it
  // without having to ask twice.
  if (typeof navigator !== 'undefined'
      && navigator.languages?.some((tag) => tag.toLowerCase().startsWith('ne'))) {
    return 'ne'
  }
  // English is the fallback because it is the language every listing has.
  return 'en'
}

/**
 * `initial` is the language the server rendered in (#45). Reading storage
 * during the first client render instead would be a hydration mismatch on
 * every visit by somebody who has chosen Nepali — React would discard the
 * server's markup and rebuild the page, which is the one thing server
 * rendering exists to avoid. Anything stronger than the server's guess is
 * applied in an effect, just after.
 *
 * The order of precedence, and why:
 *
 *   1. **A stored choice.** The reader has said, on this device, in words.
 *   2. **`?lang=` in the URL.** Explicit, and the only signal the server has —
 *      so it is what a shared Nepali link carries. `explicit` says whether the
 *      server was given one, because "en" as a default and "en" as a request
 *      are the same value and mean different things.
 *   3. **The browser's own languages.** A guess, and the weakest: it must not
 *      override a link that asked for Nepali, which is precisely the bug this
 *      ordering exists to prevent.
 */
export function LanguageProvider({ initial, explicit = false, children }: {
  initial?: Language
  explicit?: boolean
  children: ReactNode
}) {
  const [language, setLanguageState] = useState<Language>(() => initial ?? read())

  useEffect(() => {
    // A client-only render already applied the full order in `read()`.
    if (initial === undefined) return
    const stored = readStoredLanguage()
    const preferred = stored ?? (explicit ? initial : read())
    if (preferred !== initial) setLanguageState(preferred)
  }, [initial, explicit])

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // The choice still applies to this session; it just will not survive it.
    }
  }, [])

  const value = useMemo(() => ({ language, setLanguage }), [language, setLanguage])
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export const useLanguage = () => useContext(LanguageContext)

export { translate }

export function useT() {
  const { language } = useLanguage()
  return useCallback(
    (key: StringKey, values?: Record<string, string | number>) =>
      translate(key, language, values),
    [language],
  )
}

/**
 * The switch itself. Two buttons rather than a `<select>`: with two options a
 * select is a menu to open before a choice can be made, and the current
 * language has to be visible without opening anything.
 */
export function LanguageToggle() {
  const { language, setLanguage } = useLanguage()
  const t = useT()

  return (
    <div className="lang-toggle" role="group" aria-label={t('language.label')}>
      {(['en', 'ne'] as const).map((option) => (
        <button
          key={option}
          type="button"
          className="lang-toggle__option"
          // Pressed rather than checked: these are toggles that reflect a
          // setting, and a screen reader announces which one is on.
          aria-pressed={language === option}
          lang={option}
          onClick={() => setLanguage(option)}
        >
          {option === 'en' ? 'EN' : 'नेपाली'}
        </button>
      ))}
    </div>
  )
}
