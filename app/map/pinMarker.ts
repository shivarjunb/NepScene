import type { PinAppearance } from '../../api/catalog/types'

/**
 * Drawing a listing's pin (#32), as an SVG the Maps SDK can use directly.
 *
 * **The Leaflet residue stops here.** WaahTickets built a `map-leaflet-pin`
 * div with two `pin-ripple` children and a `pin-body`, assembled it into an
 * HTML string — and then never used it, because the map had already moved to
 * Google and passed `SymbolPath.CIRCLE` to the marker instead. The class names,
 * the ripple animation and the string were all dead, and the pin the author
 * previewed was not the pin the map drew. There are no class names here at all:
 * a marker icon is an image, and this returns one.
 *
 * Icon names come from the category rows (migration 0002) and are Lucide names,
 * which is what the chips already render. Only the ones the seeded categories
 * actually use are drawn; anything else falls back to the map pin, which is
 * also what an uncategorised listing gets (api/catalog/pin.ts).
 */

/**
 * Lucide glyph paths, at 24×24, stroked. Inlined rather than imported because
 * a marker icon is a data URI handed to the Maps SDK — there is no React tree
 * to render a component into, and pulling an icon library into the bundle to
 * extract twelve `d` attributes would be the tail wagging the dog.
 */
const GLYPHS: Record<string, string> = {
  Music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  Star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>',
  Trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/><path d="M4 22h16"/>',
  Laugh: '<circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  Utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Z"/>',
  Moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  Drama: '<path d="M10 11h.01"/><path d="M14 6h.01"/><path d="M18 6h.01"/><path d="M6.5 13.1h.01"/><path d="M22 5c0 9-4 12-6 12s-6-3-6-12c0-2 2-3 6-3s6 1 6 3"/><path d="M17.4 9.9c-.8.8-2 .8-2.8 0"/>',
  Users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  GraduationCap: '<path d="M22 10v6"/><path d="M6 12.5V16c0 1 2.5 3 6 3s6-2 6-3v-3.5"/><path d="M2 10l10-5 10 5-10 5z"/>',
  Film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 12h18"/>',
  ShoppingBag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  Landmark: '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  MapPin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
}

export const PIN_SIZE = 40

/**
 * A teardrop in the category's colour with its glyph knocked out in white.
 *
 * The white outline is not decoration: a pin is drawn over map tiles whose
 * colour nobody controls, and every one of the twelve category colours is
 * illegible against *some* terrain without it.
 */
export function pinSvg(pin: PinAppearance): string {
  const glyph = GLYPHS[pin.icon] ?? GLYPHS.MapPin
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_SIZE}" height="${PIN_SIZE}" viewBox="0 0 40 40">`
    + `<path d="M20 3c-6.1 0-11 4.9-11 11 0 8 11 23 11 23s11-15 11-23c0-6.1-4.9-11-11-11z"`
    + ` fill="${pin.color}" stroke="#ffffff" stroke-width="2.5"/>`
    + `<g transform="translate(11 5) scale(0.75)" fill="none" stroke="#ffffff"`
    + ` stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>`
    + '</svg>'
}

/**
 * The same SVG as a data URI. Encoded with `encodeURIComponent` rather than
 * base64: it stays readable in devtools, and the payload is smaller than the
 * 33% base64 adds.
 */
export const pinDataUri = (pin: PinAppearance): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pinSvg(pin))}`
