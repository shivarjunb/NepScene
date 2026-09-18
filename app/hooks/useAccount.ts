import { useEffect, useSyncExternalStore } from 'react'
import { accountStore, fetchAccount, type Account } from '../lib/author'

const unknown = () => undefined

/**
 * Who is signed in, for anything that only decorates itself with the answer.
 *
 * `undefined` until the first `/me` comes back — and on the server, always —
 * so the shell paints the same chrome before and after hydration and adds the
 * account controls once it knows what to show.
 */
export function useAccount(): Account | null | undefined {
  const account = useSyncExternalStore(accountStore.subscribe, accountStore.get, unknown)
  useEffect(() => {
    if (accountStore.get() === undefined) void fetchAccount().catch(() => undefined)
  }, [])
  return account
}
