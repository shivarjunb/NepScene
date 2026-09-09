import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Alert, Button, Card, Field, Input, Spinner } from '../components/primitives'
import { AuthorError, fetchAccount, register, signIn, type Account } from '../lib/author'
import { ListingWizard } from './ListingWizard'

/**
 * The `/submit` route: work out who is asking, then hand over to the wizard.
 *
 * The sign-in form here is deliberately the minimum. Authentication shipped as
 * an API in #27 with no interface at all, and the wizard is behind it, so
 * without this there is no way to demonstrate "an organizer completes a listing
 * from empty to published". Password reset, Google sign-in and the account
 * screens are #27's remaining surface and belong with it, not here.
 */
export function SubmitPage({ listingId }: { listingId: string | null }) {
  const [account, setAccount] = useState<Account | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setAccount(await fetchAccount())
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  if (loading) {
    return <div className="wizard__loading"><Spinner label="Checking your account" /></div>
  }

  if (!account) return <SignInGate onSignedIn={refresh} />

  // Signed in, but as someone who may not write. Saying which is which beats a
  // bare "forbidden" — most people in this state simply have a new account.
  if (!account.permissions.includes('listing:create')) {
    return (
      <Card raised>
        <h1>Not yet</h1>
        <p>
          Your account cannot add listings. Organizer accounts can; ask an editor
          to upgrade yours and this page will work.
        </p>
      </Card>
    )
  }

  return <ListingWizard account={account} listingId={listingId} />
}

function SignInGate({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
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
      <h1>{mode === 'signin' ? 'Sign in to add a listing' : 'Create an account'}</h1>
      <p>Anyone can add what is happening around them. You just need an account first.</p>

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
