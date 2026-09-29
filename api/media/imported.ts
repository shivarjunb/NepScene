/**
 * Covers of imported listings, served from our own origin.
 *
 * A scraped listing arrives with the source site's poster URL in
 * `cover_image_url`, and nothing else. Rendering that URL as it is hands every
 * reader the address of the site we imported from the moment they open the
 * image — the same leak that already keeps "Source:" lines out of imported
 * descriptions. So the public API never emits it: an imported cover is
 * published as `/api/media/cover/<listing id>/<version>`, a path that names our
 * row rather than their file, and the stored column is left as it is for the
 * editors who need it.
 *
 * Why the Worker mirrors rather than proxies
 * ------------------------------------------
 * Rule 1 (docs/ARCHITECTURE.md) keeps external hops off the public read path.
 * A proxy would put one on every image view. Mirroring puts one on the *first*
 * view of each cover and none after it: the bytes land in R2 under a key
 * derived from the source URL, and every later read is the same R2 read an
 * uploaded poster gets. The one hop there is has a short timeout and a size
 * cap, so a slow or dead source site costs a broken image, never a stuck page —
 * and imports run out of band (scripts/lib/katajaam.mjs), so there is no
 * earlier point in the Worker at which to do it.
 *
 * Why this is not an open proxy
 * -----------------------------
 * The route takes a listing id, never a URL. The only URLs it will fetch are
 * ones already sitting in `listings.cover_image_url` on a published import,
 * which only an importer or an editor can put there.
 */
import { FORMATS, MAX_ORIGINAL_BYTES, sizeOf } from './pipeline'
import { swallowed } from '../lib/observability'

/** How long a source site gets to answer before the cover is reported missing. */
export const UPSTREAM_TIMEOUT_MS = 4_000

/** R2 prefix for mirrored covers, apart from `listings/` so the two never collide. */
const PREFIX = 'imported'

/**
 * Whether this listing's cover is a remote file that must not be shown as it
 * is. Only imports: an authored cover URL is one its author chose to publish.
 * Anything not http(s) is excluded here and dropped by the serializer, so a
 * `javascript:` or `data:` value in a scraped row never reaches an `<img>`.
 */
export function isRemoteImportedCover(source: unknown, url: unknown): url is string {
  return source === 'import' && typeof url === 'string' && /^https?:\/\//i.test(url)
}

/**
 * The public path for an imported cover.
 *
 * `version` changes when the stored URL does, so the response can be cached as
 * immutable and a replaced poster still reaches readers. It is a 32-bit FNV-1a
 * of the URL: a cache buster, not an identifier — it cannot be reversed into
 * the URL, and it is sync, which the serializer needs (SHA-256 in Workers is
 * not). The R2 key, which nobody outside sees, uses the real hash.
 */
export function importedCoverPath(listingId: string, sourceUrl: string): string {
  return `/api/media/cover/${encodeURIComponent(listingId)}/${coverVersion(sourceUrl)}`
}

export function coverVersion(sourceUrl: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < sourceUrl.length; i++) {
    hash ^= sourceUrl.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Deterministic, so a changed cover URL is a new object and an unchanged one is fetched once. */
export async function mirrorKey(sourceUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceUrl))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${PREFIX}/${hex}`
}

export type MirrorRejection =
  | 'upstream_error'
  | 'upstream_status'
  | 'not_an_image'
  | 'too_large'
  | 'unreadable'

export type Mirrored = { ok: true; bytes: Uint8Array; mimeType: string }

/**
 * Fetches a source cover and decides whether it may be stored.
 *
 * The content type is checked against the same raster formats uploads accept,
 * and then the bytes are checked against it: a header parse, as for an upload.
 * That is what keeps an SVG or an HTML error page — either of which would run
 * as script on our origin if someone opened it directly — out of the bucket.
 */
export async function fetchCover(
  sourceUrl: string,
): Promise<Mirrored | { ok: false; reason: MirrorRejection }> {
  let response: Response
  try {
    response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { accept: Object.keys(FORMATS).join(', ') },
    })
  } catch (cause) {
    // Counted here, reported to the reader as a missing image by the route.
    swallowed('cover_mirror_fetch', cause)
    return { ok: false, reason: 'upstream_error' }
  }
  if (!response.ok) return { ok: false, reason: 'upstream_status' }

  const mimeType = normaliseMime(response.headers.get('content-type'))
  if (!(mimeType in FORMATS)) return { ok: false, reason: 'not_an_image' }

  // A declared length over the cap is refused before a byte is read; an
  // undeclared one is counted as it streams, so a lie costs at most the cap.
  const declared = Number(response.headers.get('content-length') ?? '')
  if (declared > MAX_ORIGINAL_BYTES) return { ok: false, reason: 'too_large' }
  let bytes: Uint8Array | null
  try {
    bytes = await readCapped(response, MAX_ORIGINAL_BYTES)
  } catch (cause) {
    swallowed('cover_mirror_body', cause)
    // The timeout covers the body too: a source that answers and then stalls
    // is the same failure as one that never answers.
    return { ok: false, reason: 'upstream_error' }
  }
  if (!bytes) return { ok: false, reason: 'too_large' }

  if (!sizeOf(bytes, mimeType)) return { ok: false, reason: 'unreadable' }
  return { ok: true, bytes, mimeType }
}

function normaliseMime(raw: string | null): string {
  const mime = (raw ?? '').split(';')[0]!.trim().toLowerCase()
  // Common enough from real servers that refusing it would refuse real posters.
  return mime === 'image/jpg' ? 'image/jpeg' : mime
}

async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
