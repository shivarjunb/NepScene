import { useEffect } from 'react'
import { Spinner } from '../components/primitives'
import { useAccount } from '../hooks/useAccount'
import { fetchAccount, googleErrorMessage } from '../lib/author'
import { safeNext } from '../lib/safeNext'
import { navigate, useSearch } from '../router'
import { SignInForm } from './SignInForm'

/**
 * `/login`: the sign-in page the header's "Sign in" goes to (#27).
 *
 * `?next=` says where to go afterwards; the header sets it to the page you
 * were on, and `safeNext` (app/lib/safeNext.ts) decides whether to honour it.
 */
export function LoginPage() {
  const account = useAccount()
  const search = useSearch()
  const next = safeNext(search.get('next'))
  // Set by the Google callback when it sends someone back here instead of in.
  const googleError = search.get('google_error')

  // Already signed in: there is nothing to do here, so go where "next" says.
  useEffect(() => {
    if (account) navigate(next, { replace: true })
  }, [account, next])

  if (account === undefined) {
    return <div className="wizard__loading"><Spinner label="Checking your account" /></div>
  }

  return (
    <div className="layout">
      <SignInForm
        intro="Sign in to add listings and see how yours are doing."
        returnTo={next}
        initialError={googleError ? googleErrorMessage(googleError) : null}
        onSignedIn={async () => {
          await fetchAccount()
          navigate(next, { replace: true })
        }}
      />
    </div>
  )
}
