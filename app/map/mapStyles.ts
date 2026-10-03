/**
 * The map at night.
 *
 * In the dark theme the whole site goes midnight and violet, and the map used
 * to stay Google's daytime white: the brightest thing on a phone at night,
 * and on the homepage the size of the screen. This is the style that puts it
 * in the same night as the page around it.
 *
 * **A JSON style, not `colorScheme` and not a Cloud map style.** None of the
 * maps here has a `mapId`, so the legacy `styles` option applies and needs no
 * Google Cloud console setup at all. (Google ignores `styles` the moment a
 * `mapId` is set — moving to `AdvancedMarkerElement`, which requires one,
 * would mean recreating this as a Cloud-based style.) `colorScheme` would
 * have been less code, but Google reads it only when a map is built, and the
 * site's theme changes while the page is open: an explicit choice in the
 * header, or the OS switching at sunset while the preference is `system`.
 * `styles` can be swapped on a live map with `setOptions`, which is what
 * `useMapTheme` does.
 *
 * **Recolour only.** The light map is Google's own, unstyled, so this hides
 * nothing it shows: every rule below sets a colour and the `MapStyle` type
 * allows nothing else — no `visibility: off` for a POI or a label to vanish
 * under in one theme and not the other.
 *
 * **The pins are the figure; the map is the ground.** Roads, water and parks
 * stay told apart by tone, while the only saturated colours on the map are
 * the listing pins (`pinMarker.ts`), whose white outlines were drawn for tiles
 * nobody controls and read best of all against a dark one.
 *
 * No React and no SDK types in here, so the unit tests, which run in workerd
 * without a DOM, can import it.
 */

/**
 * `google.maps.MapTypeStyle`, restated so this file needs neither the SDK's
 * types nor the DOM's. Structurally the same, so the SDK takes it as is.
 */
export type MapStyle = {
  featureType?: string
  elementType?: string
  stylers: { color: string }[]
}

export type MapTheme = 'light' | 'dark'

/** The part of `google.maps.MapOptions` that differs between the themes. */
export type MapThemeOptions = {
  styles: MapStyle[] | null
  backgroundColor: string
}

/**
 * tokens.css, as the dark theme resolves it.
 *
 * Copied by value because a JSON style is data handed to Google, not CSS — it
 * cannot read a custom property. Keyed by the token each colour mirrors, and
 * tests/unit/mapStyles.test.ts reads tokens.css and fails if any one of them
 * drifts from its token.
 */
export const DARK_TOKENS = {
  '--surface': '#141c38',              // midnight-900
  '--surface-sunken': '#0f1630',       // midnight-950
  '--surface-raised': '#1d2540',       // midnight-700
  '--text-secondary': '#cbd5e1',       // slate-300
  '--text-muted': '#94a3b8',           // slate-400
  '--accent-hover': '#c4b5fd',         // violet-300
  '--success': '#10b981',              // green-400
  '--palette-violet-600': '#7c3aed',
  '--palette-slate-950': '#020617',
  '--palette-slate-800': '#1e293b',
  '--palette-slate-700': '#334155',
  '--palette-slate-600': '#475569',
} as const

const T = DARK_TOKENS

/**
 * `top` laid over `ground` at `alpha`, as the hex a translucent token would
 * have painted. Parks and highways are a token *tinting* the land, the way
 * `--accent-wash` tints a surface; Google wants the result, not the recipe.
 */
export function mix(top: string, ground: string, alpha: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16)
  return `#${[0, 1, 2]
    .map((at) => Math.round(channel(top, at) * alpha + channel(ground, at) * (1 - alpha)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`
}

/** The land is the page's own ground, so the map and the page are one night. */
const LAND = T['--surface']
/** Deeper than the land, as water is at night. */
const WATER = T['--palette-slate-950']
/** The success green, faint: a park reads as green without lighting up. */
const PARK = mix(T['--success'], LAND, 0.18)
/** Forest and other land cover, which the light map tints too; fainter than a park. */
const LANDCOVER = mix(T['--success'], LAND, 0.09)
/** The accent, as a wash: the ring road is the one line worth finding first. */
const HIGHWAY = mix(T['--palette-violet-600'], LAND, 0.45)

/**
 * The style. Order matters: Google applies the rules top to bottom, and a
 * later, narrower rule wins over an earlier, broader one.
 */
export const DARK_MAP_STYLES: MapStyle[] = [
  // Everything starts as land, so no feature keeps a light default fill —
  // the rest of the list is the exceptions.
  { elementType: 'geometry', stylers: [{ color: LAND }] },
  { elementType: 'labels.text.fill', stylers: [{ color: T['--text-muted'] }] },
  // The halo, in the land's colour, is what keeps a label legible across a
  // road or a river it overlaps.
  { elementType: 'labels.text.stroke', stylers: [{ color: LAND }] },

  // The first rule would paint a boundary the colour of the land it divides.
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: T['--palette-slate-600'] }] },
  { featureType: 'administrative.land_parcel', elementType: 'geometry.stroke', stylers: [{ color: T['--surface-raised'] }] },
  // Place names a step brighter than street names, as on the light map.
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: T['--text-secondary'] }] },

  // Buildings and the grounds of places stand a shade proud of the land, as a
  // raised surface does on the page.
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: T['--surface-raised'] }] },
  { featureType: 'landscape.natural.landcover', elementType: 'geometry', stylers: [{ color: LANDCOVER }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: T['--surface-raised'] }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: PARK }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: T['--success'] }] },
  { featureType: 'poi.park', elementType: 'labels.text.stroke', stylers: [{ color: PARK }] },

  // Streets a step dimmer than the roads they feed, and the highways in the
  // accent — told apart by hue rather than brightness, as the light map's
  // yellow ones are. The casing is darker than the land, which is what gives
  // a dim street an edge.
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: T['--palette-slate-800'] }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: T['--surface-sunken'] }] },
  { featureType: 'road.arterial', elementType: 'geometry.fill', stylers: [{ color: T['--palette-slate-700'] }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: HIGHWAY }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: T['--accent-hover'] }] },

  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: T['--palette-slate-800'] }] },

  { featureType: 'water', elementType: 'geometry', stylers: [{ color: WATER }] },
  { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: WATER }] },
]

/**
 * What the map shows before its tiles arrive. Google paints its own light
 * grey there by default, which in the dark theme was a white flash on every
 * load and every pan into new ground; this is the land's colour, so tiles
 * landing on it do not show a seam.
 */
export const DARK_MAP_BACKGROUND = LAND

/**
 * The SDK's own default ground, which is what the light map has always loaded
 * on. Named rather than left out so both themes hand the map the same pair of
 * options, and switching back from dark asks for the light ground outright.
 */
export const LIGHT_MAP_BACKGROUND = '#e5e3df'

/**
 * The options for a theme, for a map's constructor and for `setOptions`.
 *
 * Light is `styles: null` — Google's own map, exactly as it was before this
 * existed — rather than a light style of ours.
 */
export function mapThemeOptions(theme: MapTheme): MapThemeOptions {
  return theme === 'dark'
    ? { styles: DARK_MAP_STYLES, backgroundColor: DARK_MAP_BACKGROUND }
    : { styles: null, backgroundColor: LIGHT_MAP_BACKGROUND }
}
