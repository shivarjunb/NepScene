import { useEffect, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Traps Tab inside a container and restores focus to whatever opened it (#16).
 *
 * Restoring matters as much as trapping: a dialog that returns focus to the
 * top of the document makes a keyboard user re-navigate the page every time
 * they close something.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
) {
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null
    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))

    const first = focusables()[0]
    if (first) first.focus()
    else container.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscape) {
        event.stopPropagation()
        onEscape()
        return
      }
      if (event.key !== 'Tab') return

      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const start = items[0]!
      const end = items[items.length - 1]!
      const focused = document.activeElement

      if (event.shiftKey && (focused === start || !container.contains(focused))) {
        event.preventDefault()
        end.focus()
      } else if (!event.shiftKey && focused === end) {
        event.preventDefault()
        start.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previouslyFocused?.focus?.()
    }
  }, [ref, active, onEscape])
}
