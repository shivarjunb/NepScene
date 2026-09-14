import { badRequest } from '../lib/http'

/**
 * What every admin list shares: a page, a search box, and a body parser.
 *
 * Offset paging rather than the catalogue's keyset cursor. These lists are
 * for one person scanning a few hundred rows, and "page 3 of 7" is what that
 * person wants to see; the cursor exists so a public feed of ten thousand can
 * be walked by a crawler without the offset going quadratic, and nothing here
 * is public or ten thousand long.
 */
export const PAGE = 25
export const MAX_PAGE = 100

export type Paging = { limit: number; offset: number }

export function paging(url: URL): Paging {
  return {
    limit: Math.min(Number(url.searchParams.get('limit')) || PAGE, MAX_PAGE),
    offset: Math.max(Number(url.searchParams.get('offset')) || 0, 0),
  }
}

/**
 * The search term as typed, and as a LIKE pattern with the wildcards the
 * person typed escaped — "50%" should find "50%", not everything after 50.
 */
export function search(url: URL): { query: string; pattern: string } {
  const query = (url.searchParams.get('q') ?? '').trim()
  return { query, pattern: `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` }
}

/** Fetched one past the page so `has_more` is known without a COUNT(*). */
export function page<T>(rows: T[], { limit, offset }: Paging) {
  const hasMore = rows.length > limit
  return {
    data: hasMore ? rows.slice(0, limit) : rows,
    page: { limit, offset, has_more: hasMore },
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object') throw new Error('not an object')
    return body as Record<string, unknown>
  } catch {
    throw badRequest('invalid_body', 'Send a JSON object')
  }
}
