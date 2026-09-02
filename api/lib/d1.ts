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
