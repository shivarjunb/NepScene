import type { Context } from 'hono'

/** Errors thrown with this are rendered as a JSON body; anything else is a 500. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const badRequest = (code: string, message: string) => new ApiError(400, code, message)
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message)

export type ErrorBody = { error: { code: string; message: string } }

export function errorResponse(err: unknown, requestId: string): Response {
  const known = err instanceof ApiError
  const status = known ? err.status : 500
  const body: ErrorBody = {
    error: {
      code: known ? err.code : 'internal_error',
      message: known ? err.message : 'Something went wrong',
    },
  }
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-request-id': requestId },
  })
}

/** Correlation id per request (docs/DEVOPS.md, monitoring). */
export function requestId(c: Context): string {
  return c.req.header('cf-ray') ?? crypto.randomUUID()
}

/**
 * Reads a bounded integer query parameter.
 * Anything unparseable is a 400 rather than a silent default — a typo'd limit
 * that quietly returns 20 rows is how unbounded reads get missed in review.
 */
export function intParam(
  raw: string | undefined,
  { name, fallback, min, max }: { name: string; fallback: number; min: number; max: number },
): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n)) throw badRequest('invalid_parameter', `${name} must be an integer`)
  if (n < min || n > max) {
    throw badRequest('invalid_parameter', `${name} must be between ${min} and ${max}`)
  }
  return n
}

export function floatParam(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) throw badRequest('invalid_parameter', `${name} must be a number`)
  return n
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/

/** Accepts a date or a full ISO timestamp; normalises to an ISO-8601 UTC string. */
export function dateParam(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined || raw === '') return undefined
  if (!ISO_DATE.test(raw)) throw badRequest('invalid_parameter', `${name} must be an ISO-8601 date`)
  const ms = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw)
  if (Number.isNaN(ms)) throw badRequest('invalid_parameter', `${name} must be an ISO-8601 date`)
  return new Date(ms).toISOString()
}

export function boolParam(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1'
}
