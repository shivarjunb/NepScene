/**
 * Sharing a listing (#43).
 *
 * **WhatsApp comes first, and that is not a default.** It is how a link
 * travels in Nepal — an event reaches people through a group chat long before
 * it reaches them through a feed — so it is the first affordance rather than
 * one of four icons in a row.
 *
 * `api.whatsapp.com/send` rather than the `whatsapp://` scheme: the https form
 * opens the app when it is installed and WhatsApp Web when it is not, where
 * the scheme fails silently on a desktop with nothing registered for it.
 */
export type ShareTarget = {
  id: 'whatsapp' | 'facebook' | 'x' | 'copy'
  href?: string
}

export function shareTargets(url: string, title: string): ShareTarget[] {
  const encodedUrl = encodeURIComponent(url)
  return [
    { id: 'whatsapp', href: `https://api.whatsapp.com/send?text=${encodeURIComponent(`${title} — ${url}`)}` },
    { id: 'facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}` },
    { id: 'x', href: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodeURIComponent(title)}` },
    { id: 'copy' },
  ]
}

/**
 * Directions, handed off to whatever maps app the reader has (#44).
 *
 * Coordinates when they exist, the written address when they do not. A Google
 * Place id is better than either where one was captured by the venue picker
 * (#31), because it opens the place's own card rather than a dropped pin.
 *
 * `google.com/maps` rather than a platform-specific scheme: iOS offers to open
 * it in Apple Maps, Android opens the Google Maps app, and a desktop gets the
 * web map. A `geo:` URI would be the pure answer and does nothing on desktop.
 */
export function directionsUrl(place: {
  latitude: number | null
  longitude: number | null
  address: string | null
  name: string
  google_place_id?: string | null
}): string {
  const base = 'https://www.google.com/maps/search/?api=1'
  if (place.google_place_id) {
    return `${base}&query=${encodeURIComponent(place.name)}&query_place_id=${encodeURIComponent(place.google_place_id)}`
  }
  if (place.latitude !== null && place.longitude !== null) {
    return `${base}&query=${place.latitude}%2C${place.longitude}`
  }
  const written = [place.name, place.address].filter(Boolean).join(', ')
  return `${base}&query=${encodeURIComponent(written)}`
}
