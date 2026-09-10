import { useEffect, useId, useRef, useState } from 'react'
import type { Suggestion } from '../lib/catalog'
import { fetchSuggestions } from '../lib/client'
import { useT } from '../i18n'
import { navigate } from '../router'

/**
 * The search field, with suggestions as you type (#42).
 *
 * **150ms of stillness, not 150ms of typing.** The timer restarts on every
 * keystroke, so a request is made when the reader *stops*, not four times
 * through one word. #42's criterion is suggestions within 100ms of typing
 * stopping; the request that follows is served from the edge cache for minutes
 * at a time, which is what makes that reachable from Kathmandu at all.
 *
 * **A combobox, spelled out.** This is the ARIA pattern rather than a div with
 * a list under it: a text input with `role=combobox`, an owned listbox, arrow
 * keys that move `aria-activedescendant` without moving focus, and Enter that
 * takes the highlighted option. Getting this wrong makes a search box that a
 * screen reader user cannot tell is offering anything.
 */
const DEBOUNCE_MS = 150
const MIN_QUERY = 2

export function SearchBox({ initial = '', autoFocus = false }: {
  initial?: string
  autoFocus?: boolean
}) {
  const t = useT()
  const listId = useId()
  const [value, setValue] = useState(initial)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const boxRef = useRef<HTMLDivElement>(null)

  // The field follows the URL: arriving at /search?q=jazz, or pressing Back
  // out of a search, must not leave the old text in the box.
  useEffect(() => { setValue(initial) }, [initial])

  useEffect(() => {
    const query = value.trim()
    if (query.length < MIN_QUERY) {
      setSuggestions([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchSuggestions(query, controller.signal)
        .then((page) => {
          if (!controller.signal.aborted) {
            setSuggestions(page.data)
            setActive(-1)
          }
        })
        .catch(() => {
          // Suggestions are an accelerator. Losing them costs nothing the
          // reader can act on — the form still submits.
        })
    }, DEBOUNCE_MS)

    return () => { clearTimeout(timer); controller.abort() }
  }, [value])

  // A click outside closes the list. Without this it stays open over whatever
  // the reader clicked next.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const submit = (query: string) => {
    setOpen(false)
    navigate(`/search?q=${encodeURIComponent(query.trim())}`)
  }

  const take = (suggestion: Suggestion) => {
    setOpen(false)
    // A suggestion that names one thing goes to that thing; one that names a
    // group runs the search. Sending every suggestion to a result page would
    // make picking a listing by name take two clicks to reach it.
    if (suggestion.kind === 'listing') return navigate(`/listings/${suggestion.slug}`)
    if (suggestion.kind === 'venue') return navigate(`/venues/${suggestion.slug}`)
    if (suggestion.kind === 'organizer') return navigate(`/organizers/${suggestion.slug}`)
    if (suggestion.kind === 'artist') return navigate(`/artists/${suggestion.slug}`)
    if (suggestion.kind === 'category') return navigate(`/search?category=${encodeURIComponent(suggestion.slug)}`)
    if (suggestion.kind === 'tag') return navigate(`/search?tag=${encodeURIComponent(suggestion.slug)}`)
    return submit(suggestion.label)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) {
      if (event.key === 'ArrowDown' && suggestions.length > 0) {
        event.preventDefault()
        setOpen(true)
        setActive(0)
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => (current + step + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault()
      take(suggestions[active] as Suggestion)
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  const expanded = open && suggestions.length > 0

  return (
    <div className="searchbox" ref={boxRef}>
      <form
        className="searchbox__form"
        role="search"
        onSubmit={(event) => { event.preventDefault(); submit(value) }}
      >
        <input
          className="searchbox__input"
          type="search"
          value={value}
          autoFocus={autoFocus}
          placeholder={t('search.placeholder')}
          aria-label={t('search.title')}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(event) => { setValue(event.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <button className="btn btn--primary searchbox__submit" type="submit">
          {t('search.submit')}
        </button>
      </form>

      <ul
        className="searchbox__list"
        id={listId}
        role="listbox"
        aria-label={t('search.suggestions')}
        hidden={!expanded}
      >
        {suggestions.map((suggestion, index) => (
          <li
            key={`${suggestion.kind}:${suggestion.slug}:${suggestion.label}`}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            className={`searchbox__option ${index === active ? 'is-active' : ''}`}
            // Mouse down rather than click: a click fires after the input has
            // already blurred and closed the list out from under the pointer.
            onMouseDown={(event) => { event.preventDefault(); take(suggestion) }}
            onMouseEnter={() => setActive(index)}
          >
            <span className="searchbox__option-label">{suggestion.label}</span>
            <span className="searchbox__option-kind">{suggestion.kind}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
