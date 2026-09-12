import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { deferred } from '../../app/lib/deferred'

/**
 * #39's route splitting rests on one contract: the server and the first
 * client render of a deferred component produce the same markup — the
 * fallback — so hydration has nothing to reconcile and `renderToString` never
 * meets a suspended boundary. What that means on the server is simple to
 * pin: the loader is not consulted at all, and the fallback is what renders.
 */
describe('deferred()', () => {
  it('renders the fallback on the server without touching the loader', () => {
    let loads = 0
    const Late = deferred<{ name: string }>(
      () => { loads += 1; return Promise.resolve(({ name }: { name: string }) => createElement('b', null, name)) },
      createElement('span', { className: 'waiting' }, 'Loading…'),
    )

    const html = renderToString(createElement(Late, { name: 'never' }))

    expect(html).toBe('<span class="waiting">Loading…</span>')
    expect(html).not.toContain('never')
    expect(loads).toBe(0)
  })

  it('emits no Suspense markers, so there is nothing for the client to redo', () => {
    const Late = deferred<object>(
      () => Promise.resolve(() => createElement('b', null, 'late')),
      createElement('span', null, 'Loading…'),
    )

    // `<!--$!-->` is how renderToString marks a boundary it gave up on; its
    // absence is the point of not using React.lazy here.
    expect(renderToString(createElement(Late, {}))).not.toContain('<!--$')
  })
})
