import { useEffect, useState, type FormEvent } from 'react'
import { Alert, Button, Card, Field, Input } from '../components/primitives'
import { AuthorError, fetchGoogleStatus, googleSignInUrl, register, signIn } from '../lib/author'

type Props = {
  /** What signing in is for, as a heading: "Sign in" on /login, "Sign in to add a listing" on /submit. */
  heading?: string
  intro?: string
  /** Where Google sign-in lands afterwards; it leaves the page, so `onSignedIn` never runs for it. */
  returnTo: string
  /** An error to open with — /login's `?google_error=`, already turned into words. */
  initialError?: string | null
  onSignedIn: () => void | Promise<void>
}

/**
 * The one sign-in form, shared by /login and the wizard's gate.
 *
 * Email and password, the same card turned round for a new account, and
 * Google sign-in where this environment has credentials for it.
 */
export function SignInForm({ heading = 'Sign in', intro, returnTo, initialError = null, onSignedIn }: Props) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(initialError)
  const [busy, setBusy] = useState(false)
  const google = useGoogleEnabled()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await (mode === 'signin' ? signIn(email, password) : register(email, password))
      await onSignedIn()
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'That did not work')
      setBusy(false)
    }
  }

  return (
    <Card raised className="wizard__signin">
      <h1>{mode === 'signin' ? heading : 'Create an account'}</h1>
      {intro && <p>{intro}</p>}

      {error && <Alert tone="danger" title="Could not sign you in">{error}</Alert>}

      {google && (
        <>
          {/* An anchor, not a fetch: the flow leaves the site and comes back. */}
          <a className="btn btn--secondary btn--block" href={googleSignInUrl(returnTo)}>
            Continue with Google
          </a>
          <p className="wizard__divider" aria-hidden="true">or</p>
        </>
      )}

      {/* A real form: Enter submits, and password managers recognise it. */}
      <form onSubmit={submit} className="wizard__fields">
        <Field label="Email">
          {({ id }) => (
            <Input id={id} type="email" autoComplete="email" required value={email}
                   onChange={(e) => setEmail(e.target.value)} />
          )}
        </Field>
        <Field label="Password"
               hint={mode === 'register' ? 'At least 12 characters' : undefined}>
          {({ id, describedBy }) => (
            <Input id={id} type="password" required value={password}
                   aria-describedby={describedBy}
                   autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                   onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>
        <Button type="submit" loading={busy}>
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
      </form>

      <Button variant="ghost" onClick={() => {
        setMode(mode === 'signin' ? 'register' : 'signin')
        setError(null)
      }}>
        {mode === 'signin' ? 'I do not have an account' : 'I already have an account'}
      </Button>
    </Card>
  )
}

/** False until the Worker says otherwise — the button appears rather than vanishes. */
function useGoogleEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let live = true
    fetchGoogleStatus()
      .then((status) => { if (live) setEnabled(status.enabled) })
      // Unreachable status means no button; the password form still works.
      .catch(() => { if (live) setEnabled(false) })
    return () => { live = false }
  }, [])
  return enabled
}
