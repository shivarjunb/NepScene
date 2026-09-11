/**
 * Nothing is caught silently (#50).
 *
 * The motivating case is F2 in the WaahTickets audit: paid orders producing no
 * tickets, because the failure was swallowed into a response header nobody
 * read. It was invisible for as long as it existed — and the lesson
 * generalises. **An error that is caught and not reported is worse than one
 * that crashes**, because it removes the signal without removing the problem.
 *
 * So the rule for NepScene is that every `catch` does one of two things:
 *
 *   1. **Rethrows** — usually as an `ApiError`, which the caller sees and the
 *      error handler renders. The signal survives; nothing to do here.
 *   2. **Swallows** — returns a default, degrades, carries on. That is often
 *      the right behaviour, and it is exactly the case that has to be counted.
 *      `swallowed()` is how.
 *
 * `scripts/lib/guards.mjs` enforces the choice: a catch block in `api/` that
 * neither rethrows nor calls `swallowed()` fails CI. That is what stops this
 * being a convention that decays.
 *
 * **Why a log line rather than a metrics client.** Workers has no counter API
 * that does not cost a binding and an account-level dataset. A structured line
 * on stdout is picked up by Workers Logs and by any Logpush job without
 * configuration, so the counter exists the moment this ships rather than the
 * moment somebody wires a dashboard. The shape below is stable and greppable
 * precisely so a dashboard can be built on it later without touching this code.
 */

/** Every line carries this, so one query finds all of them. */
const CHANNEL = 'nepscene'

export type LogLevel = 'info' | 'warn' | 'error'

export type LogFields = Record<string, string | number | boolean | null | undefined>

/**
 * The correlation id for the request in flight.
 *
 * Workers gives each request its own isolate-level execution context but no
 * async-local storage, so this is set once per request by the fetch handler
 * and read by anything that logs. A module-level variable is safe here for the
 * reason it would not be in Node: a Worker handles one request at a time per
 * isolate, and an `await` cannot interleave another request into the same one.
 */
let currentRequestId: string | null = null

export function setRequestId(id: string | null): void {
  currentRequestId = id
}

export function getRequestId(): string | null {
  return currentRequestId
}

/**
 * One structured line. JSON, on one line, because that is what every log
 * pipeline can parse and what a human can still read in `wrangler tail`.
 */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = {
    channel: CHANNEL,
    level,
    event,
    // The correlation id, on every line related to one request — which is the
    // whole point: an error is only useful if you can find what led to it.
    request_id: currentRequestId,
    at: new Date().toISOString(),
    ...fields,
  }
  const serialised = JSON.stringify(line)
  if (level === 'error') console.error(serialised)
  else if (level === 'warn') console.warn(serialised)
  else console.log(serialised)
}

/**
 * An error that was caught and deliberately not rethrown.
 *
 * Call this at every such site. `reason` is a stable, low-cardinality slug —
 * it is the thing a dashboard groups by, so it must not contain an id, a slug,
 * a URL or a message. Anything variable goes in `fields`.
 *
 * Swallowing is frequently correct: a KV read that fails should not lock
 * everyone out of sign-in, and a malformed cursor should not 500 a page. What
 * is never correct is doing it without leaving a trace, because then the
 * difference between "this never happens" and "this happens constantly" is
 * invisible from outside.
 */
export function swallowed(reason: string, cause: unknown, fields: LogFields = {}): void {
  logEvent('warn', 'swallowed', {
    reason,
    // The message, not the stack: a stack from a minified Worker bundle is
    // noise, and the reason slug is what actually identifies the site.
    cause: cause instanceof Error ? cause.message : String(cause),
    ...fields,
  })
}

/**
 * A request that failed. Distinct from `swallowed` because this one *did*
 * reach the client as an error — it is counted so the rate can be alerted on,
 * not because the signal was at risk of being lost.
 */
export function requestFailed(
  status: number, code: string, fields: LogFields = {},
): void {
  logEvent(status >= 500 ? 'error' : 'warn', 'request_failed', { status, code, ...fields })
}
