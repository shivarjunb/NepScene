import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest, notFound } from '../lib/http'
import { auditStatement } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { imageSize } from '../lib/imageSize'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { mediaUrl } from '../catalog/serialize'
import { loadEditableListing } from './listings'

/**
 * The write half of the media pipeline (#25): bytes go to R2 under a key the
 * application owns; the row in listing_media is the index the catalogue reads.
 */
export const authorMediaRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const MAX_BYTES = 10 * 1024 * 1024
/** Enough of the file to hold any header we parse. */
const HEADER_BYTES = 64 * 1024

const ALLOWED = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
])

authorMediaRoutes.post(
  '/listings/:id/media',
  requirePermission('media:upload'),
  async (c) => {
    const listingId = c.req.param('id')
    const user = c.get('user')
    await loadEditableListing(c.env, user.id, user.role, listingId)

    const form = await c.req.raw.formData().catch(() => {
      throw badRequest('invalid_body', 'Send multipart/form-data with a file field')
    })
    const file = form.get('file')
    if (!(file instanceof File)) throw badRequest('missing_file', 'Attach a file')

    const extension = ALLOWED.get(file.type)
    if (!extension) {
      throw badRequest('unsupported_type', `Images only: ${[...ALLOWED.keys()].join(', ')}`)
    }
    if (file.size > MAX_BYTES) {
      throw new ApiError(400, 'file_too_large', 'Images must be under 10MB')
    }

    // Alt text is required, not optional: a listing image with no alt text is a
    // WCAG 2.1 AA failure the moment it renders (#49).
    const altText = String(form.get('alt_text') ?? '').trim().slice(0, 300)
    if (!altText) throw badRequest('missing_alt_text', 'Describe the image for screen readers')

    const bytes = new Uint8Array(await file.arrayBuffer())
    // Dimensions come from the header so the client can reserve space and the
    // page does not shift when the image lands.
    const size = imageSize(bytes.subarray(0, HEADER_BYTES), file.type)

    const mediaId = crypto.randomUUID()
    const key = `listings/${listingId}/${mediaId}.${extension}`

    await c.env.MEDIA.put(key, bytes, {
      httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
    })

    const now = new Date().toISOString()
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO listing_media
           (id, listing_id, r2_key, kind, mime_type, width, height, bytes, alt_text,
            sort_order, created_by, created_at)
         VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8,
                 (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM listing_media WHERE listing_id = ?2),
                 ?9, ?10)`,
      ).bind(mediaId, listingId, key, file.type, size?.width ?? null, size?.height ?? null,
             file.size, altText, user.id, now),
      auditStatement(c.env, {
        entityType: 'media', entityId: mediaId, action: 'media_added',
        actorId: user.id, actorRole: user.role,
        details: { listing_id: listingId, bytes: file.size, mime_type: file.type },
      }),
    ])

    c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

    return c.json(
      {
        id: mediaId,
        url: mediaUrl(key),
        alt_text: altText,
        bytes: file.size,
        width: size?.width ?? null,
        height: size?.height ?? null,
      },
      201,
    )
  },
)

authorMediaRoutes.delete('/media/:mediaId', requirePermission('media:upload'), async (c) => {
  const user = c.get('user')
  const media = await c.env.DB.prepare(
    'SELECT id, listing_id, r2_key FROM listing_media WHERE id = ?1',
  ).bind(c.req.param('mediaId')).first<{ id: string; listing_id: string; r2_key: string }>()
  if (!media) throw notFound('No such media')

  await loadEditableListing(c.env, user.id, user.role, media.listing_id)

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM listing_media WHERE id = ?1').bind(media.id),
    auditStatement(c.env, {
      entityType: 'media', entityId: media.id, action: 'media_removed',
      actorId: user.id, actorRole: user.role, details: { listing_id: media.listing_id },
    }),
  ])
  // R2 last: a row without bytes renders a broken image, bytes without a row
  // are merely unreferenced.
  c.executionCtx.waitUntil(c.env.MEDIA.delete(media.r2_key))
  c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

  return c.json({ ok: true })
})
