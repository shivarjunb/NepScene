import type { Env } from '../env'

/**
 * Every public read goes through a D1 session in `first-unconstrained` mode, so
 * a nearby read replica serves it instead of the APAC primary. Measured from
 * Kathmandu against WaahTickets on 2026-09-02: a single primary round trip
 * costs a flat ~200ms regardless of query complexity, so the only number that
 * matters on this path is how many round trips a request makes.
 *
 * `roundTrips` exists to keep that number honest — it is emitted as a
 * Server-Timing header, and the integration tests assert on it. One for a
 * cached read, two or three for anything; a fourth is a design smell
 * (docs/ARCHITECTURE.md, rule 4).
 */
export type ReadSession = {
  first<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** One network round trip for N statements — prefer it over sequential calls. */
  batch<T = Record<string, unknown>>(
    statements: { sql: string; params?: unknown[] }[],
  ): Promise<T[][]>
  readonly roundTrips: number
}

export function readSession(env: Env): ReadSession {
  const session = env.DB.withSession('first-unconstrained')
  let roundTrips = 0

  return {
    async first<T>(sql: string, params: unknown[] = []) {
      roundTrips++
      return (await session.prepare(sql).bind(...params).first<T>()) ?? null
    },
    async all<T>(sql: string, params: unknown[] = []) {
      roundTrips++
      const { results } = await session.prepare(sql).bind(...params).all<T>()
      return results
    },
    async batch<T>(statements: { sql: string; params?: unknown[] }[]) {
      roundTrips++
      const prepared = statements.map((s) => session.prepare(s.sql).bind(...(s.params ?? [])))
      const results = await session.batch<T>(prepared)
      return results.map((r) => r.results)
    },
    get roundTrips() {
      return roundTrips
    },
  }
}

/**
 * The write path's counterpart. Two differences from `readSession`, both
 * deliberate: it goes to the primary, because an author who has just saved must
 * read back what they saved and a replica may lag; and it counts the same way,
 * because "no sequential request that could run in parallel" (#30) is only a
 * real constraint if something measures it. Handlers stamp the count with
 * `withRoundTrips`, and the integration tests assert on it.
 */
export type WriteSession = {
  first<T = Record<string, unknown>>(statement: D1PreparedStatement): Promise<T | null>
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>
  readonly roundTrips: number
}

export function writeSession(env: Env): WriteSession {
  let roundTrips = 0
  return {
    async first<T>(statement: D1PreparedStatement) {
      roundTrips++
      return (await statement.first<T>()) ?? null
    },
    async batch(statements: D1PreparedStatement[]) {
      roundTrips++
      return env.DB.batch(statements)
    },
    get roundTrips() {
      return roundTrips
    },
  }
}

/**
 * Every handler that touches D1 reports how many round trips it took. From
 * Kathmandu each one is a flat ~200ms (docs/ARCHITECTURE.md), so this number is
 * the response time, and leaving it unmeasured is how a waterfall gets in.
 */
export function withRoundTrips(response: Response, session: { roundTrips: number }): Response {
  response.headers.set('x-d1-round-trips', String(session.roundTrips))
  return response
}

/**
 * D1 hands back `unknown` columns, and `noUncheckedIndexedAccess` makes a
 * batch's result slots optional. These three are the whole answer: read a
 * column at the type you expect, or get null.
 */
export const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

export const numeric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export const rowsOf = <T>(result: { results?: unknown[] } | undefined): T[] =>
  (result?.results ?? []) as T[]
