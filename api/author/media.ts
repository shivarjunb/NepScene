import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest, notFound } from '../lib/http'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { can } from '../identity/roles'
import { mediaUrl } from '../catalog/serialize'
import { bumpCatalogVersion } from '../lib/cache'

/**
 * The write half of the media pipeline (#25). Bytes go to R2 under a key the
 * application owns; the row in listing_media is the index the catalogue reads.
 */
export const authorMediaRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const MAX_BYTES = 10 * 1024 * 1024
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
    await assertCanEditListing(c.env, user.id, user.role, listingId)

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

    const mediaId = crypto.randomUUID()
    const key = `listings/${listingId}/${mediaId}.${extension}`

    await c.env.MEDIA.put(key, file.stream(), {
      httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
    })

    const now = new Date().toISOString()
    await c.env.DB.prepare(
      `INSERT INTO listing_media
         (id, listing_id, r2_key, kind, mime_type, bytes, alt_text, sort_order, created_by, created_at)
       VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6,
               (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM listing_media WHERE listing_id = ?2),
               ?7, ?8)`,
    ).bind(mediaId, listingId, key, file.type, file.size, altText, user.id, now).run()

    c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

    return c.json(
      { id: mediaId, url: mediaUrl(key), alt_text: altText, bytes: file.size },
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

  await assertCanEditListing(c.env, user.id, user.role, media.listing_id)

  await c.env.DB.prepare('DELETE FROM listing_media WHERE id = ?1').bind(media.id).run()
  // R2 last: a row without bytes renders a broken image, bytes without a row
  // are merely unreferenced.
  c.executionCtx.waitUntil(c.env.MEDIA.delete(media.r2_key))
  c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

  return c.json({ ok: true })
})

async function assertCanEditListing(
  env: Env,
  userId: string,
  role: Parameters<typeof can>[0],
  listingId: string,
): Promise<void> {
  const listing = await env.DB.prepare(
    'SELECT id, created_by, organization_id FROM listings WHERE id = ?1',
  ).bind(listingId).first<{ id: string; created_by: string | null; organization_id: string | null }>()
  if (!listing) throw notFound('No such listing')

  if (can(role, 'listing:edit_any')) return
  if (listing.created_by === userId) return

  if (listing.organization_id) {
    const membership = await env.DB.prepare(
      'SELECT 1 AS ok FROM organization_users WHERE organization_id = ?1 AND user_id = ?2',
    ).bind(listing.organization_id, userId).first<{ ok: number }>()
    if (membership) return
  }

  throw new ApiError(403, 'forbidden', 'That listing belongs to someone else')
}
