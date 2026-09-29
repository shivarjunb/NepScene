import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Checkbox, Field, Input } from '../components/primitives'
import { AuthorError } from '../lib/author'
import { deployToProduction, fetchDeployState, setAutoPromote, type DeployState, type ProductionRun } from '../lib/admin'

/**
 * "Deploy to production", on the staging console only: the API answers 404
 * anywhere else, and this card then renders nothing.
 *
 * It fills in what used to be copied by hand — the newest commit that went
 * green on staging, and a name made of what it brings in — and starts the
 * production workflow. Approval still happens in GitHub; the workflow
 * @mentions the reviewers when it gets there, and this card says so while a
 * deploy is waiting.
 *
 * The switch below makes staging's own deploy press the button after each
 * green run. It says, right beside it, that approval still does not: that is
 * the one thing someone turning it on must not have to guess.
 */
export function DeployCard() {
  const [state, setState] = useState<DeployState | null>(null)
  const [hidden, setHidden] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await fetchDeployState()
      setState(next)
      setReason((current) => current || next.reason)
    } catch (caught) {
      if (caught instanceof AuthorError && caught.status === 404) setHidden(true)
      else setError(caught instanceof AuthorError ? caught.message : 'Could not reach GitHub')
    }
  }, [])

  useEffect(() => { void load() }, [load])
  // While a deploy is under way, keep its status current: GitHub takes a few
  // seconds to show a dispatched run, and the approval gate is what matters.
  const finished = started ? state?.recent.find((run) => run.sha === started && run.status === 'completed') ?? null : null
  useEffect(() => {
    if (!(started && !finished) && !state?.active) return
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [started, finished, state?.active, load])

  if (hidden) return null

  const deploy = async () => {
    if (!state?.candidate) return
    setBusy(true)
    setError(null)
    try {
      await deployToProduction(state.candidate.sha, reason)
      setStarted(state.candidate.sha)
      await load()
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'That did not work')
    } finally {
      setBusy(false)
    }
  }

  const toggleAuto = async (enabled: boolean) => {
    setSwitching(true)
    setError(null)
    try {
      const { auto_promote } = await setAutoPromote(enabled)
      setState((current) => current && { ...current, auto_promote })
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'That did not work')
    } finally {
      setSwitching(false)
    }
  }

  const candidate = state?.candidate
  const active = state?.active
  return (
    <Card raised className="admin__job">
      <div className="admin__row-body">
        <h2 className="admin__row-title">Deploy to production</h2>
        <p className="board__meta">
          Promotes the newest commit that deployed to staging. You approve it in
          GitHub; you are @mentioned there, by email and in the GitHub app, when
          it is waiting.
        </p>
        {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}
        {!state && !error && <p className="board__meta">Asking GitHub…</p>}
        {state && (
          <>
            <p className="board__meta">
              Production is on {state.production ? <a href={state.production.url} target="_blank" rel="noreferrer"><code>{short(state.production.sha)}</code></a> : 'an unknown commit'}.
              {' '}{candidate
                ? <>Staging is {state.ahead.length === 1 ? 'one commit' : `${state.ahead.length} commits`} ahead.</>
                : <>Staging has nothing production is missing.</>}
            </p>
            <Checkbox label="Promote to production automatically after a green staging deploy"
                      checked={state.auto_promote} disabled={switching}
                      onChange={(event) => void toggleAuto(event.target.checked)} />
            <p className="board__meta">
              {state.auto_promote ? 'On' : 'Off'}. Automatic only starts the deploy — it still waits
              for a reviewer to approve it in GitHub, exactly like one started here. Nothing reaches
              production without that approval.
            </p>
            {active && <ActiveDeploy run={active} />}
            {started && !active && !finished && (
              <Alert tone="info" title="Started">GitHub is picking it up; this card updates on its own.</Alert>
            )}
            {finished && (
              <Alert tone={finished.conclusion === 'success' ? 'success' : 'danger'}
                     title={finished.conclusion === 'success' ? 'Deployed to production' : `Deploy ${finished.conclusion ?? 'stopped'}`}>
                <a href={finished.url} target="_blank" rel="noreferrer">See the run in GitHub →</a>
              </Alert>
            )}
            {candidate && !active && (
              <>
                <ul className="admin__keys" aria-label="What this deploy brings in">
                  {state.ahead.map((commit) => (
                    <li key={commit.sha}><code>{short(commit.sha)}</code> {commit.title}</li>
                  ))}
                </ul>
                <Field label="Name for this deploy" hint="Shown in GitHub's production history and the audit trail.">
                  {({ id, describedBy }) => (
                    <Input id={id} aria-describedby={describedBy} value={reason} maxLength={300}
                           onChange={(event) => setReason(event.target.value)} />
                  )}
                </Field>
              </>
            )}
            {state.recent.length > 0 && <p className="board__meta">Recent production deploys:</p>}
            {state.recent.length > 0 && (
              <ul className="admin__keys" aria-label="Recent production deploys">
                {state.recent.map((run) => (
                  <li key={run.url}>
                    <a href={run.url} target="_blank" rel="noreferrer">{run.sha ? <code>{short(run.sha)}</code> : 'Deploy'}</a>{' '}
                    {run.automatic && <><Badge tone="accent">Automatic</Badge>{' '}</>}
                    {run.status === 'completed' ? (run.conclusion ?? 'stopped') : run.status.replace('_', ' ')}
                    {' · '}{new Date(run.created_at).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="admin__row-actions">
        <Button type="button" loading={busy} disabled={busy || !candidate || Boolean(active) || !reason.trim()}
                onClick={() => void deploy()}>
          {candidate ? `Deploy ${short(candidate.sha)}` : 'Deploy'}
        </Button>
      </div>
    </Card>
  )
}

function ActiveDeploy({ run }: { run: ProductionRun }) {
  if (run.status === 'waiting') {
    return (
      <Alert tone="warning" title="Waiting for your approval">
        <a href={run.url} target="_blank" rel="noreferrer">Review and approve in GitHub →</a>
      </Alert>
    )
  }
  return (
    <p className="board__meta">
      <Badge tone="accent">{run.status.replace('_', ' ')}</Badge>{' '}
      <a href={run.url} target="_blank" rel="noreferrer">{run.title}</a>
    </p>
  )
}

const short = (sha: string) => sha.slice(0, 7)
