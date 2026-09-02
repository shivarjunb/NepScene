import { useId, useRef, useState, type ReactNode } from 'react'

type Tab = { id: string; label: string; content: ReactNode }

/**
 * Tabs with the roving tabindex the WAI-ARIA pattern calls for (#16): one stop
 * in the tab order, arrows move between tabs, Home and End jump to the ends.
 * Arrowing to a tab selects it, which is what a sighted keyboard user expects.
 */
export function Tabs({ tabs, label }: { tabs: Tab[]; label: string }) {
  const [selected, setSelected] = useState(0)
  const baseId = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  const focusTab = (index: number) => {
    const next = (index + tabs.length) % tabs.length
    setSelected(next)
    refs.current[next]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const moves: Record<string, number | undefined> = {
      ArrowRight: selected + 1,
      ArrowLeft: selected - 1,
      Home: 0,
      End: tabs.length - 1,
    }
    const target = moves[event.key]
    if (target === undefined) return
    event.preventDefault()
    focusTab(target)
  }

  return (
    <div className="tabs">
      <div className="tabs__list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => { refs.current[index] = node }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab.id}`}
            className="tabs__tab"
            aria-selected={index === selected}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={index === selected ? 0 : -1}
            onClick={() => setSelected(index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          className="tabs__panel"
          hidden={index !== selected}
          tabIndex={0}
        >
          {index === selected && tab.content}
        </div>
      ))}
    </div>
  )
}
