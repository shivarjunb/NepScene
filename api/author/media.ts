import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest, notFound } from '../lib/http'
import { auditStatement } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { mediaUrl } from '../catalog/serialize'
import {
  checkDerivative, contentHash, derivativeKey, FORMATS, MAX_ORIGINAL_BYTES,
  MIME_BY_FORMAT, originalKey, sizeOf, widthsFor, type Format,
} from '../media/pipeline'
import { loadEditableListing } from './access'

/**
 * The write half of the media pipeline (#25): bytes go to R2 under a key
 * derived from the bytes themselves; the rows in listing_media and
 * media_derivatives are the index the catalogue reads.
 *
 * The rules — what counts as a derivative, which widths exist, how a key is
 * built — live in api/media/pipeline.ts. This file is the plumbing.
 */
export const authorMediaRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** Everything R2 needs to hold one object, gathered before anything is written. */
type Upload = { key: string; bytes: Uint8Array; mimeType: string }

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

    const format = FORMATS[file.type as keyof typeof FORMATS]
    if (!format) {
      throw badRequest('unsupported_type', `Images only: ${Object.keys(FORMATS).join(', ')}`)
    }
    if (file.size > MAX_ORIGINAL_BYTES) {
      throw new ApiError(400, 'file_too_large', 'Images must be under 10MB')
    }

    // Alt text is required, not optional: a listing image with no alt text is a
    // WCAG 2.1 AA failure the moment it renders (#49).
    const altText = String(form.get('alt_text') ?? '').trim().slice(0, 300)
    if (!altText) throw badRequest('missing_alt_text', 'Describe the image for screen readers')

    const bytes = new Uint8Array(await file.arrayBuffer())
    // Dimensions come from the header so the client can reserve space and the
    // page does not shift when the image lands.
    const size = sizeOf(bytes, file.type)
    if (!size) throw badRequest('unreadable_image', 'That file is not a readable image')

    const hash = await contentHash(bytes)
    const key = originalKey(listingId, hash, format)
    const now = new Date().toISOString()

    // Same bytes, same listing, same key — so a retried upload replaces its own
    // row instead of leaving a second copy of the same picture behind.
    const existing = await c.env.DB.prepare(
      'SELECT id FROM listing_media WHERE listing_id = ?1 AND content_hash = ?2',
    ).bind(listingId, hash).first<{ id: string }>()

    const { accepted: derivatives, rejected } = await collectDerivatives(
      form, { listingId, hash, original: size },
    )

    const objects: Upload[] = [
      { key, bytes, mimeType: file.type },
      ...derivatives.map((d) => ({ key: d.key, bytes: d.bytes, mimeType: MIME_BY_FORMAT[d.format] })),
    ]

    // R2 first: an object with no row is unreferenced, a row with no object is
    // a broken image. The sweep below reclaims the former.
    await Promise.all(objects.map((object) =>
      c.env.MEDIA.put(object.key, object.bytes as unknown as ArrayBuffer, {
        httpMetadata: { contentType: object.mimeType, cacheControl: IMMUTABLE },
      }),
    ))

    const id = existing?.id ?? crypto.randomUUID()
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO listing_media
           (id, listing_id, r2_key, kind, mime_type, width, height, bytes, alt_text,
            content_hash, sort_order, created_by, created_at)
         VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, ?9,
                 (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM listing_media WHERE listing_id = ?2),
                 ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET alt_text = ?8, r2_key = ?3, mime_type = ?4`,
      ).bind(id, listingId, key, file.type, size.width, size.height, file.size, altText,
             hash, user.id, now),
      ...derivatives.map((d) =>
        c.env.DB.prepare(
          `INSERT INTO media_derivatives (id, media_id, r2_key, format, width, height, bytes, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(media_id, format, width) DO UPDATE SET r2_key = ?3, bytes = ?7`,
        ).bind(crypto.randomUUID(), id, d.key, d.format, d.width, d.height, d.bytes.length, now),
      ),
      auditStatement(c.env, {
        entityType: 'media', entityId: id, action: existing ? 'media_replaced' : 'media_added',
        actorId: user.id, actorRole: user.role,
        details: {
          listing_id: listingId, bytes: file.size, mime_type: file.type,
          derivatives: derivatives.length, rejected: rejected.length,
        },
      }),
    ]
    await c.env.DB.batch(statements)

    c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

    return c.json(
      {
        id,
        url: mediaUrl(key),
        alt_text: altText,
        bytes: file.size,
        width: size.width,
        height: size.height,
        // What the client should have sent, so a partial upload is visible
        // rather than quietly producing a one-rung srcset.
        expected_widths: widthsFor(size.width),
        derivatives: derivatives.map((d) => ({
          url: mediaUrl(d.key), format: d.format, width: d.width, bytes: d.bytes.length,
        })),
        rejected,
      },
      existing ? 200 : 201,
    )
  },
)

type Derivative = { key: string; bytes: Uint8Array; width: number; height: number; format: Format }
type Rejection = { width: number | null; reason: string }
type Collected = { accepted: Derivative[]; rejected: Rejection[] }

/**
 * Every `derivative` part, verified against the original and de-duplicated by
 * (format, width).
 *
 * A rejected part does not fail the upload. The original is what the listing
 * actually needs, and a client that encodes one bad rung should not lose the
 * other three — but the rejections come back in the response, so a silently
 * one-rung srcset is not something anyone has to discover from a waterfall.
 */
async function collectDerivatives(
  form: FormData,
  { listingId, hash, original }:
  { listingId: string; hash: string; original: { width: number; height: number } },
): Promise<Collected> {
  const accepted: Derivative[] = []
  const rejected: Rejection[] = []
  const seen = new Set<string>()

  for (const part of form.getAll('derivative')) {
    if (!(part instanceof File)) {
      rejected.push({ width: null, reason: 'not_a_file' })
      continue
    }

    const bytes = new Uint8Array(await part.arrayBuffer())
    const check = checkDerivative({
      bytes: part.size,
      mimeType: part.type,
      // Parsed from the part's own header. Nothing the request *says* about a
      // derivative is used; this is what makes client-side encoding safe.
      size: sizeOf(bytes, part.type),
      original,
    })
    if (!check.ok) {
      rejected.push({ width: null, reason: check.reason })
      continue
    }

    const variant = `${check.format}:${check.width}`
    if (seen.has(variant)) {
      rejected.push({ width: check.width, reason: 'duplicate_variant' })
      continue
    }
    seen.add(variant)

    accepted.push({
      key: derivativeKey(listingId, hash, check.width, check.format),
      bytes,
      width: check.width,
      height: check.height,
      format: check.format,
    })
  }

  return { accepted, rejected }
}

// ─── DELETE /api/author/media/:mediaId ───────────────────────────────────────
authorMediaRoutes.delete('/media/:mediaId', requirePermission('media:upload'), async (c) => {
  const user = c.get('user')
  const media = await c.env.DB.prepare(
    'SELECT id, listing_id, r2_key FROM listing_media WHERE id = ?1',
  ).bind(c.req.param('mediaId')).first<{ id: string; listing_id: string; r2_key: string }>()
  if (!media) throw notFound('No such media')

  await loadEditableListing(c.env, user.id, user.role, media.listing_id)

  // Read the derivative keys before the rows go: ON DELETE CASCADE removes
  // them, and after that there is no way left to find the objects.
  const derivatives = await c.env.DB.prepare(
    'SELECT r2_key FROM media_derivatives WHERE media_id = ?1',
  ).bind(media.id).all<{ r2_key: string }>()

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM listing_media WHERE id = ?1').bind(media.id),
    auditStatement(c.env, {
      entityType: 'media', entityId: media.id, action: 'media_removed',
      actorId: user.id, actorRole: user.role,
      details: { listing_id: media.listing_id, derivatives: derivatives.results.length },
    }),
  ])

  // R2 last: a row without bytes renders a broken image, bytes without a row
  // are merely unreferenced — and the sweep below collects those.
  const keys = [media.r2_key, ...derivatives.results.map((row) => row.r2_key)]
  c.executionCtx.waitUntil(c.env.MEDIA.delete(keys))
  c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

  return c.json({ ok: true, deleted_objects: keys.length })
})

// ─── POST /api/author/media/sweep ────────────────────────────────────────────
/**
 * Orphaned-object cleanup (#25). Every write path here puts bytes in R2 before
 * it writes the row that references them, so a request that dies in between
 * leaves an object nothing points at. That is the right way round — the other
 * order leaves broken images — but it means something has to collect them.
 *
 * Deliberately a request rather than a cron: R2 list is cheap, the bucket is
 * small, and an admin who can see what it would delete before it deletes it is
 * worth more than one that runs unattended at 3am. `dry_run` is the default for
 * the same reason.
 */
const SWEEP_PAGE = 1000

authorMediaRoutes.post('/media/sweep', requirePermission('user:manage'), async (c) => {
  const user = c.get('user')
  const dryRun = new URL(c.req.url).searchParams.get('dry_run') !== 'false'

  const referenced = new Set<string>()
  for (const table of ['listing_media', 'media_derivatives']) {
    const rows = await c.env.DB.prepare(`SELECT r2_key FROM ${table}`).all<{ r2_key: string }>()
    for (const row of rows.results) referenced.add(row.r2_key)
  }

  const orphans: string[] = []
  let cursor: string | undefined
  let scanned = 0
  do {
    const page = await c.env.MEDIA.list({ prefix: 'listings/', limit: SWEEP_PAGE, cursor })
    scanned += page.objects.length
    for (const object of page.objects) {
      if (!referenced.has(object.key)) orphans.push(object.key)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  if (!dryRun && orphans.length > 0) {
    // R2 deletes in batches of 1000.
    for (let i = 0; i < orphans.length; i += SWEEP_PAGE) {
      await c.env.MEDIA.delete(orphans.slice(i, i + SWEEP_PAGE))
    }
    await c.env.DB.batch([
      auditStatement(c.env, {
        entityType: 'media', entityId: 'sweep', action: 'orphans_swept',
        actorId: user.id, actorRole: user.role,
        details: { scanned, deleted: orphans.length },
      }),
    ])
  }

  return c.json({ scanned, orphans: orphans.length, deleted: dryRun ? 0 : orphans.length, dry_run: dryRun, keys: orphans.slice(0, 50) })
})
