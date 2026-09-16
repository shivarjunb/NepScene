/**
 * Every address the app answers, as data — no React, so the Worker can read
 * it too.
 *
 * The asset layer's SPA fallback serves `index.html` for anything that is not
 * a file, and it does so with a 200 — so `/nope` used to be indexable, and
 * `/login` before it shipped was too. The Worker now runs first for every
 * page-shaped path and asks this table; a miss gets the same shell with a 404,
 * which is what tells a crawler to drop the URL (#108). The router in
 * app/routes.tsx is typed against these same lists, so a route cannot exist
 * without the Worker knowing about it — that is the whole point of keeping
 * the table here rather than in either place.
 */
export const STATIC_PATHS = [
  '/',
  '/search',
  '/map',
  '/venues',
  '/organizers',
  '/submit',
  '/login',
  '/dashboard',
  '/moderate',
  '/admin',
  '/about',
  '/privacy',
  '/accessibility',
  '/design-system',
] as const

export type StaticPath = (typeof STATIC_PATHS)[number]

/** `/thing/:slug` — the slug is one segment: non-empty, and no `/` in it. */
export const DYNAMIC_PREFIXES = [
  '/listings/',
  '/venues/',
  '/organizers/',
  '/artists/',
  '/submit/',
  '/admin/',
] as const

export type DynamicPrefix = (typeof DYNAMIC_PREFIXES)[number]

/** Whether the app has a page for this path — not whether that page has content. */
export function isAppPath(pathname: string): boolean {
  if ((STATIC_PATHS as readonly string[]).includes(pathname)) return true
  return DYNAMIC_PREFIXES.some((prefix) => {
    if (!pathname.startsWith(prefix)) return false
    const slug = pathname.slice(prefix.length)
    return slug.length > 0 && !slug.includes('/')
  })
}
