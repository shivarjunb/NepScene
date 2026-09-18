import { useCallback, useEffect, useState } from 'react'
import { Card, Spinner } from '../components/primitives'
import { fetchAccount, type Account } from '../lib/author'
import { ListingWizard } from './ListingWizard'
import { SignInForm } from './SignInForm'

/**
 * The `/submit` route: work out who is asking, then hand over to the wizard.
 *
 * The gate is the same form as /login, kept in place rather than redirected
 * to: someone who followed "Add a listing" should sign in and land in the
 * wizard, not on a page that then sends them back here.
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

  if (!account) {
    return (
      <SignInForm
        heading="Sign in to add a listing"
        intro="Anyone can add what is happening around them. You just need an account first."
        onSignedIn={refresh}
      />
    )
  }

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
