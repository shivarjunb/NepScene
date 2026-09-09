import type { MediaItem } from '../lib/catalog'

/**
 * A catalogue image, rendered the only way that meets #25's criteria (#49 for
 * the alt text).
 *
 * Three things are doing the work, and all three are easy to leave out:
 *
 *   - `<picture>` with a source per format, so a browser that understands AVIF
 *     never downloads the JPEG. The API orders them; the browser picks.
 *   - `sizes`, without which a srcset is decoration — the browser assumes the
 *     image is the full viewport width and fetches the widest rung on a phone.
 *   - `width`/`height` and `aspect-ratio`, so the box exists before the bytes
 *     do. This is the difference between a feed that settles and one that
 *     jumps under the reader's thumb.
 */
export function ResponsiveImage({ media, sizes, alt, className, priority = false }: {
  media: MediaItem
  /** How wide this image renders, per breakpoint. Required: see above. */
  sizes: string
  /** Overrides the stored alt text. `''` marks the image decorative. */
  alt?: string
  className?: string
  /** Above the fold. Turns off lazy loading, which delays what is already visible. */
  priority?: boolean
}) {
  const ratio = media.aspect_ratio ?? (media.width && media.height ? media.width / media.height : null)

  return (
    <picture className={className}>
      {media.sources.map((source) => (
        <source key={source.type} type={source.type} srcSet={source.srcset} sizes={sizes} />
      ))}
      <img
        src={media.url}
        alt={alt ?? media.alt_text ?? ''}
        width={media.width ?? undefined}
        height={media.height ?? undefined}
        // The intrinsic attributes above cover most browsers; the property
        // covers the case where CSS has already constrained one dimension.
        style={ratio ? { aspectRatio: String(ratio) } : undefined}
        loading={priority ? 'eager' : 'lazy'}
        decoding={priority ? 'sync' : 'async'}
        fetchPriority={priority ? 'high' : undefined}
      />
    </picture>
  )
}
