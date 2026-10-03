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

/** The teardrop, whose point is at (20, 37) and whose body is centred on (20, 14). */
const TEARDROP = 'M20 3c-6.1 0-11 4.9-11 11 0 8 11 23 11 23s11-15 11-23c0-6.1-4.9-11-11-11z'

/**
 * A teardrop in the category's colour with its glyph knocked out in white.
 *
 * The white outline is not decoration: a pin is drawn over map tiles whose
 * colour nobody controls, and every one of the twelve category colours is
 * illegible against *some* terrain without it.
 *
 * `count` is how many listings the pin stands for (#37). Above one it grows a
 * stacked shadow behind it and a count bubble in front — both drawn inside the
 * same 40×40 box, so a grouped pin and a single one share an anchor and the
 * map does not shift the point that means "here" depending on how busy the
 * venue is.
 */
export function pinSvg(pin: PinAppearance, count = 1): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_SIZE}" height="${PIN_SIZE}" viewBox="0 0 40 40">`
    + pinShapes(pin, count)
    + '</svg>'
}

/**
 * The pin itself, in the 40×40 box's units: what a resting pin and a selected
 * one both draw, so picking a pin out can never change which pin it is.
 *
 * `ring` goes between a grouped pin's stacked shadow and the pin in front, so
 * a selected stack's ring runs unbroken round the pin rather than being
 * crossed by the shadow behind it.
 */
function pinShapes(pin: PinAppearance, count: number, ring = ''): string {
  const glyph = GLYPHS[pin.icon] ?? GLYPHS.MapPin
  const grouped = count > 1

  // Drawn first so it sits behind. Offset up and right, which reads as depth
  // in a top-down view; offsetting downward would read as a second pin at a
  // different place.
  const stack = grouped
    ? `<path d="${TEARDROP}" transform="translate(3 -3)" fill="${pin.color}"`
      + ' stroke="#ffffff" stroke-width="2.5" opacity="0.55"/>'
    : ''

  const bubble = grouped ? countBubble(countLabel(count)) : ''

  return stack
    + ring
    + `<path d="${TEARDROP}"`
    + ` fill="${pin.color}" stroke="#ffffff" stroke-width="2.5"/>`
    + `<g transform="translate(11 5) scale(0.75)" fill="none" stroke="#ffffff"`
    + ` stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>`
    + bubble
}

/**
 * Past 99 the bubble stops being a number and becomes a shape. Kept in step
 * with `bubbleLabel` in venueGrouping.ts, which is the same decision made for
 * the DOM; a test asserts they agree.
 */
export function countLabel(count: number): string {
  return count > 99 ? '99+' : String(count)
}

/**
 * The bubble, in the top-right of the box.
 *
 * Slate rather than the category colour: the bubble is a count, not a
 * category, and tinting it would make two grouped pins of different
 * categories look like they carried different *kinds* of number. The white
 * ring separates it from the teardrop it overlaps.
 */
function countBubble(label: string): string {
  // "99+" needs a wider bubble than "3" and a smaller face to sit in it.
  const wide = label.length > 2
  const fontSize = wide ? 8.5 : 10
  return `<g transform="translate(30.5 8.5)">`
    + `<circle r="${wide ? 9 : 8}" fill="#0f172a" stroke="#ffffff" stroke-width="2"/>`
    + `<text x="0" y="0" text-anchor="middle" dominant-baseline="central"`
    + ` font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"`
    + ` font-size="${fontSize}" font-weight="700" fill="#ffffff">${label}</text>`
    + '</g>'
}

/**
 * The same SVG as a data URI. Encoded with `encodeURIComponent` rather than
 * base64: it stays readable in devtools, and the payload is smaller than the
 * 33% base64 adds.
 */
export const pinDataUri = (pin: PinAppearance, count = 1): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pinSvg(pin, count))}`

/**
 * The selected pin: the one whose card is open.
 *
 * The card opens across the top of the map rather than above its pin, which
 * is what stopped it being clipped — and what left nothing on a busy map to
 * say which pin it belonged to. So that pin is picked out, three ways, because
 * each alone fails somewhere: it is larger, so it is found at a glance; it
 * wears a ring and a halo in the site's accent, the colour the rest of the
 * interface already uses for "this one"; and it is drawn above its neighbours,
 * which is the marker's z-index rather than anything an icon can do
 * (useSelectedMarker.ts).
 */
export type PinTheme = 'light' | 'dark'

/**
 * The accent, per theme. Literal, like every colour in this file, because a
 * marker icon is a data URI and cannot read a custom property: these are
 * `--accent` in app/styles/tokens.css — violet-600 in the light theme,
 * violet-400 in the dark — and a unit test reads that file to hold them to it.
 */
export const SELECTED_RING: Record<PinTheme, string> = {
  light: '#7c3aed',
  dark: '#a78bfa',
}

/** How much larger a selected marker is drawn than a resting one. */
const SELECTED_SCALE = 1.25

/**
 * The selected pin's box, in the resting pin's units: the 40×40 box with room
 * around it for the halo, and below it for the ring around the point.
 */
const SELECTED_BOX = { x: -6, y: -8, side: 52 }

export const SELECTED_PIN_SIZE = SELECTED_BOX.side * SELECTED_SCALE

/**
 * Where the selected pin is anchored, in pixels: the resting pin's anchor,
 * (20, 40) in its own units, found again in the larger box. The ring reaches
 * below the point, so this is not the box's bottom edge as a resting pin's is
 * — but it is the same spot on the ground, and a pin that slid when it was
 * picked out would be pointing somewhere else.
 */
export const SELECTED_PIN_ANCHOR = {
  x: (PIN_SIZE / 2 - SELECTED_BOX.x) * SELECTED_SCALE,
  y: (PIN_SIZE - SELECTED_BOX.y) * SELECTED_SCALE,
}

/**
 * A ring drawn along `shape`'s edge: the accent, with white outside it.
 *
 * The white is the pin outline's reason again — the tiles underneath are not
 * ours. And the shape's own white outline, drawn over the inner edge, keeps
 * the accent off the fill: two category colours are violets, and an accent
 * ring touching a violet pin would vanish into it.
 */
const selectionRing = (shape: string, accent: string): string =>
  `${shape} fill="none" stroke="#ffffff" stroke-width="12" stroke-linejoin="round"/>`
  + `${shape} fill="none" stroke="${accent}" stroke-width="8" stroke-linejoin="round"/>`

export function selectedPinSvg(pin: PinAppearance, count = 1, theme: PinTheme = 'light'): string {
  const accent = SELECTED_RING[theme]
  const { x, y, side } = SELECTED_BOX
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SELECTED_PIN_SIZE}" height="${SELECTED_PIN_SIZE}" viewBox="${x} ${y} ${side} ${side}">`
    // The halo, round the head where the eye goes, so the pin reads as lit
    // from across the screen and not only once it has been found.
    + `<circle cx="20" cy="14" r="20" fill="${accent}" opacity="0.3"/>`
    + pinShapes(pin, count, selectionRing(`<path d="${TEARDROP}"`, accent))
    + '</svg>'
}

export const selectedPinDataUri = (pin: PinAppearance, count = 1, theme: PinTheme = 'light'): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(selectedPinSvg(pin, count, theme))}`

/**
 * The viewer's own position (#38).
 *
 * A ringed dot, not a teardrop. A listing pin points *at* something that is
 * happening; the viewer is not one of those, and drawing them as one puts a
 * thirteenth category on the map. Every map in the world uses a dot for this
 * and there is no reason to be the exception.
 */
export const ME_SIZE = 22

export function meSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ME_SIZE}" height="${ME_SIZE}" viewBox="0 0 22 22">`
    // The halo, so the dot survives a dark tile as well as a pale one.
    + '<circle cx="11" cy="11" r="10" fill="#2563eb" opacity="0.2"/>'
    + '<circle cx="11" cy="11" r="5" fill="#2563eb" stroke="#ffffff" stroke-width="2.5"/>'
    + '</svg>'
}

export const meDataUri = (): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(meSvg())}`

/**
 * A cluster bubble (#39).
 *
 * Not a teardrop: a teardrop points at one place, and a cluster is a statement
 * about an area. Sized by what it holds, so a screen of bubbles reads as a
 * density map rather than as a field of identical circles — but sized in three
 * steps rather than continuously, because a continuous scale makes two bubbles
 * of 40 and 44 look meaningfully different when they are not.
 */
export const CLUSTER_SIZES = [44, 54, 64]

export function clusterSize(count: number): number {
  if (count >= 500) return CLUSTER_SIZES[2]!
  if (count >= 100) return CLUSTER_SIZES[1]!
  return CLUSTER_SIZES[0]!
}

export function clusterSvg(count: number): string {
  const size = clusterSize(count)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    // The soft outer ring is what makes a bubble readable over map tiles whose
    // colour nobody controls — the same reason the pin has a white outline.
    + `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1}" fill="#1d4ed8" opacity="0.25"/>`
    + clusterCore(count, size)
    + '</svg>'
}

/** The bubble and its number, in a `size` box: shared by resting and selected. */
function clusterCore(count: number, size: number): string {
  const label = count > 9999 ? '9999+' : String(count)
  // Shrinks as the label lengthens, so "1234" fits the same circle "12" does.
  const fontSize = size / (2.2 + label.length * 0.42)

  return `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 7}" fill="#1d4ed8" stroke="#ffffff" stroke-width="2.5"/>`
    + `<text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central"`
    + ` font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"`
    + ` font-size="${fontSize.toFixed(1)}" font-weight="700" fill="#ffffff">${label}</text>`
}

export const clusterDataUri = (count: number): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clusterSvg(count))}`

/**
 * A selected bubble: one that opened a stack, because no zoom could pull its
 * places apart. Picked out the way a selected pin is, with the accent ring
 * and halo standing in for the soft ring. A bubble that zooms instead never
 * opens a card and is never drawn this way.
 */
const CLUSTER_MARGIN = 6

export function selectedClusterSize(count: number): number {
  return (clusterSize(count) + 2 * CLUSTER_MARGIN) * SELECTED_SCALE
}

export function selectedClusterSvg(count: number, theme: PinTheme = 'light'): string {
  const accent = SELECTED_RING[theme]
  const size = clusterSize(count)
  const side = size + 2 * CLUSTER_MARGIN
  const centre = size / 2
  const drawn = selectedClusterSize(count)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${drawn}" height="${drawn}" viewBox="${-CLUSTER_MARGIN} ${-CLUSTER_MARGIN} ${side} ${side}">`
    + `<circle cx="${centre}" cy="${centre}" r="${side / 2 - 1}" fill="${accent}" opacity="0.3"/>`
    + selectionRing(`<circle cx="${centre}" cy="${centre}" r="${centre - 7}"`, accent)
    + clusterCore(count, size)
    + '</svg>'
}

export const selectedClusterDataUri = (count: number, theme: PinTheme = 'light'): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(selectedClusterSvg(count, theme))}`
