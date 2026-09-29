import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, notFound } from '../lib/http'
import { readSession } from '../lib/d1'
import { logEvent } from '../lib/observability'
import {
  coverVersion, fetchCover, importedCoverPath, isRemoteImportedCover, mirrorKey,
} from './imported'

/**
 * The read half of the media pipeline (#25): bytes come from R2 through the
 * Worker so the bucket stays private and the URL survives a storage change.
 * Uploads are authored, so they land with the author module once identity does.
 */
export const mediaRoutes = new Hono<{ Bindings: Env }>()

const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * An imported listing's cover, from our origin (api/media/imported.ts).
 *
 * Registered before the wildcard so `cover/` is never read as an R2 key. One
 * D1 read resolves the id to the stored URL; R2 answers from then on, and the
 * source site is asked only when R2 has nothing under that URL's key yet.
 */
mediaRoutes.get('/cover/:id/:version', async (c) => {
  const id = c.req.param('id')
  const row = await readSession(c.env).first<{ source: string; cover_image_url: string | null }>(
    `SELECT source, cover_image_url FROM listings WHERE id = ?1 AND status = 'published'`,
    [id],
  )
  if (!row || !isRemoteImportedCover(row.source, row.cover_image_url)) {
    throw notFound('No such media')
  }
  const sourceUrl = row.cover_image_url

  // A page cached before the cover changed still asks for the old version.
  // Sent on rather than served, because this URL is cached as immutable and
  // must never come to mean a different picture.
  if (c.req.param('version') !== coverVersion(sourceUrl)) {
    return c.redirect(importedCoverPath(id, sourceUrl), 302)
  }

  const key = await mirrorKey(sourceUrl)
  const stored = await c.env.MEDIA.get(key)
  if (stored) return serve(c.req.header('if-none-match'), stored)

  const fetched = await fetchCover(sourceUrl)
  if (!fetched.ok) {
    // The id, never the URL: the log is not a place to rediscover the source.
    logEvent('warn', 'cover_mirror_rejected', { listing_id: id, reason: fetched.reason })
    throw new ApiError(502, 'cover_unavailable', 'This cover could not be loaded')
  }
  const written = await c.env.MEDIA.put(key, fetched.bytes, {
    httpMetadata: { contentType: fetched.mimeType },
  })
  // `put` answers null only for a conditional write, which this is not; the
  // fallback is for the type, and still says what the bytes are.
  const headers = written
    ? headersFor(written)
    : new Headers({ 'content-type': fetched.mimeType, 'x-content-type-options': 'nosniff' })
  return new Response(fetched.bytes, { headers })
})

mediaRoutes.get('/*', async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/api\/media\//, ''))
  if (!key || key.includes('..')) throw notFound('No such media')

  const object = await c.env.MEDIA.get(key)
  if (!object) throw notFound('No such media')
  return serve(c.req.header('if-none-match'), object)
})

function headersFor(object: R2Object): Headers {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  // Keys are written once and never rewritten, so this can be immutable.
  headers.set('cache-control', IMMUTABLE)
  // Bytes that came from someone else's server are served as the image type
  // they were checked against, and never re-sniffed as anything else.
  headers.set('x-content-type-options', 'nosniff')
  return headers
}

function serve(ifNoneMatch: string | undefined, object: R2ObjectBody): Response {
  const headers = headersFor(object)
  if (ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(object.body, { headers })
}
