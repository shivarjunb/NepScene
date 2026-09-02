import { Hono } from 'hono'
import type { Env } from '../env'
import { notFound } from '../lib/http'

/**
 * The read half of the media pipeline (#25): bytes come from R2 through the
 * Worker so the bucket stays private and the URL survives a storage change.
 * Uploads are authored, so they land with the author module once identity does.
 */
export const mediaRoutes = new Hono<{ Bindings: Env }>()

const IMMUTABLE = 'public, max-age=31536000, immutable'

mediaRoutes.get('/*', async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/api\/media\//, ''))
  if (!key || key.includes('..')) throw notFound('No such media')

  const object = await c.env.MEDIA.get(key)
  if (!object) throw notFound('No such media')

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  // Keys are written once and never rewritten, so this can be immutable.
  headers.set('cache-control', IMMUTABLE)

  if (c.req.header('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(object.body, { headers })
})
