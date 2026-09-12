import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { Alert } from '../components/primitives'

/**
 * A component that arrives in its own chunk (#39).
 *
 * The whole app used to be one 109KB module, and it was on every first paint:
 * a visitor opening a listing from a shared link downloaded the authoring
 * wizard, the moderation queue and the component gallery before the page
 * could respond to a tap. `deferred()` moves a component behind `import()`,
 * which Vite turns into a separate file fetched the first time it renders.
 *
 * **Not `React.lazy`, on purpose.** The server renders with `renderToString`,
 * which does not wait for a suspended component — it writes the fallback and
 * flags the boundary for the client to redo, and reports the suspension as an
 * error while it does so. This one renders the fallback on the server and on
 * the first client render alike, from the same code, so the markup React
 * hydrates is exactly the markup the server sent. The chunk is requested in
 * an effect, which is to say after hydration, which is the only time a
 * browser could act on the result anyway.
 *
 * Once loaded, the module is remembered at module scope: a second visit to
 * the wizard renders it in the same pass, with no fallback flashed in between.
 */
export function deferred<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode,
): ComponentType<P> {
  let loaded: ComponentType<P> | null = null

  return function Deferred(props: P) {
    const [Component, setComponent] = useState<ComponentType<P> | null>(() => loaded)
    const [failed, setFailed] = useState(false)

    useEffect(() => {
      if (loaded) return
      let mounted = true
      load().then(
        (component) => {
          loaded = component
          if (mounted) setComponent(() => loaded)
        },
        // A chunk that does not arrive — a deploy between the shell and the
        // click, a connection that dropped — must not leave a spinner that
        // never stops. The browser's own error is not hidden; the page just
        // says what a reload would fix.
        (cause: unknown) => {
          console.error('chunk_load_failed', cause)
          if (mounted) setFailed(true)
        },
      )
      return () => { mounted = false }
    }, [])

    if (Component) return <Component {...props} />
    if (failed) {
      return (
        <Alert tone="danger" title="This part of the page did not load">
          Reload the page to try again.
        </Alert>
      )
    }
    return <>{fallback}</>
  }
}
