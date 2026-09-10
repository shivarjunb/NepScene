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

const read = (): Language => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'ne') return stored
  } catch {
    // Storage can be unavailable — a private window, or storage disabled.
    // English is the fallback because it is the language every listing has.
  }
  // An explicit choice wins, but a browser that asks for Nepali gets it
  // without having to ask twice.
  if (typeof navigator !== 'undefined'
      && navigator.languages?.some((tag) => tag.toLowerCase().startsWith('ne'))) {
    return 'ne'
  }
  return 'en'
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(read)

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
