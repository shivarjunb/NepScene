import type { ListingDetail, MediaItem } from './catalog'

/** Imported posters may have only a cover URL, without a media record. */
export function listingImages(listing: Pick<ListingDetail, 'cover' | 'cover_image_url' | 'media'>): MediaItem[] {
  const cover: MediaItem | null = listing.cover ?? (listing.cover_image_url ? {
    id: 'cover', url: listing.cover_image_url, kind: 'image', alt_text: null,
    width: null, height: null, aspect_ratio: null, sources: [],
  } : null)
  const seen = new Set<string>()
  return [...(cover ? [cover] : []), ...listing.media].filter((item) => {
    if (item.kind !== 'image' || !item.url || seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
}
