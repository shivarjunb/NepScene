import { Link } from '../router'

/**
 * Note the honesty gap: this renders at HTTP 200, because the SPA fallback
 * serves index.html for every path and only a server that knows the routes can
 * answer 404. Server rendering (#45) is what makes the status match the page.
 */
export function NotFound({ path }: { path: string }) {
  return (
    <div className="layout stack page-placeholder">
      <h1>Page not found</h1>
      <p className="muted">
        Nothing lives at <code>{path}</code>.
      </p>
      <p className="page-placeholder__note">
        <Link href="/">Back to Discover</Link>
      </p>
    </div>
  )
}
