import { Badge } from '../components/primitives'

/**
 * A route that exists but is not built yet.
 *
 * The alternative — leaving the link dead, or hiding it until its feature
 * lands — makes progress invisible and hides the shell's own bugs until the
 * end. This says what will be here and which issue puts it there, so the
 * staging site reads as a site under construction rather than a broken one.
 *
 * Every one of these is deleted by the feature named on it. What is left is
 * /about and /privacy, which are copy rather than features and have no issue
 * scheduling them.
 */
export type Planned = {
  title: string
  summary: string
  /** The issue that replaces this page. Omitted when nothing schedules it yet. */
  issue?: number
  milestone?: string
}

export function Placeholder({ title, summary, issue, milestone }: Planned) {
  return (
    <div className="layout stack page-placeholder">
      <header className="stack">
        <div className="page-placeholder__meta">
          <Badge tone="accent">Not built yet</Badge>
          {milestone && <Badge>{milestone}</Badge>}
        </div>
        <h1>{title}</h1>
        <p className="muted">{summary}</p>
      </header>

      <p className="page-placeholder__note">
        {issue ? (
          <>
            This page arrives with{' '}
            <a href={`https://github.com/shivarjunb/NepScene/issues/${issue}`}
               target="_blank" rel="noreferrer">issue #{issue}</a>.
          </>
        ) : (
          <>Nothing schedules this page yet — it has no issue.</>
        )}
      </p>
    </div>
  )
}
