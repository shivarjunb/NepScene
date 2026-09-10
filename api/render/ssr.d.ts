/**
 * The contract between the Worker and the browser components it renders (#45).
 *
 * **Why this file exists at all.** The Worker's TypeScript config has no DOM
 * lib on purpose — the Workers runtime types and the DOM's disagree, most
 * visibly about `CacheStorage`, and mixing them hides real errors. But the
 * server renderer *is* browser code: it imports components whose effects touch
 * `document` and `window`. Typechecking those under the Worker's config fails
 * on every effect; typechecking them with the DOM lib added breaks
 * `caches.default` in four places, which was measured rather than assumed.
 *
 * So the two worlds meet here, at a declaration. TypeScript resolves `#ssr` to
 * this file and never opens the components; wrangler's esbuild resolves it to
 * `app/server.tsx` and bundles them (wrangler.jsonc `alias`). The components
 * stay typechecked by tsconfig.app.json, where the DOM lib belongs, and this
 * file is the surface that has to stay in step — four lines of it.
 */
declare module '#ssr' {
  export type ServerLocation = { path: string; search: string }
  export type ServerLanguage = 'en' | 'ne'

  /**
   * The app, as HTML, for the given URL and language. `preloaded` is this
   * request's data, keyed by the API path the browser would otherwise fetch —
   * passed in rather than left on a global, because one isolate serves many
   * requests at once.
   */
  export function renderApp(
    location: ServerLocation,
    language: ServerLanguage,
    preloaded: Record<string, unknown>,
  ): string

  /** The document title for a path — the same table the browser uses. */
  export function titleForPath(path: string): string
}
