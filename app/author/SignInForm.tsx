import { useState, type FormEvent } from 'react'
import { Alert, Button, Card, Field, Input } from '../components/primitives'
import { AuthorError, register, signIn } from '../lib/author'

type Props = {
  /** What signing in is for, as a heading: "Sign in" on /login, "Sign in to add a listing" on /submit. */
  heading?: string
  intro?: string
  onSignedIn: () => void | Promise<void>
}

/**
 * The one sign-in form, shared by /login and the wizard's gate.
 *
 * Deliberately the minimum: email and password, and the same card turned
 * round for a new account. Password reset and Google sign-in are #27's
 * remaining surface and belong with it, not here.
 */
export function SignInForm({ heading = 'Sign in', intro, onSignedIn }: Props) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
