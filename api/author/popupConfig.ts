import { swallowed } from '../lib/observability'
/**
 * What a listing's map popup shows, and in what order (#32).
 *
 * Ported from WaahTickets' `MapPopupCustomizer`, with the field set closed
 * rather than free. There, `popupConfig` was whatever JSON the client sent and
 * the map rendered `field` as a key lookup — so an unknown field was a blank
 * row nobody could explain, and a stored label was arbitrary text rendered on
 * a public page. Both are avoided by validating here, which is also why this
 * lives beside `validate.ts` and is free of platform globals: the wizard and
 * the Worker apply one definition, not two.
 *
 * The customisation deliberately stops at *ordering, visibility and labels*.
 * Pin colour and icon are not customisable at all — they are derived from the
 * primary category (api/catalog/pin.ts), which is the decision #32 asked to
 * reconsider on the way in. WaahTickets let an author set `map_pin_icon`
 * independently, then needed a separate `pinCategory` concept to reconcile the
 * pin with the filter chips, and the two drifted anyway. One value read twice
 * cannot disagree with itself.
 */

/**
 * The closed set. Each is something the listing already knows; none of them is
 * a free-text slot, because a popup is four lines on a phone and an author
 * given an empty box will write a paragraph into it.
 */
export const POPUP_FIELDS = ['venue', 'when', 'category', 'summary', 'offer'] as const
export type PopupFieldKey = (typeof POPUP_FIELDS)[number]

export type PopupField = {
  field: PopupFieldKey
  /** What to call it in this listing's popup. Capped, never HTML. */
  label: string
  visible: boolean
}

export type PopupConfig = { fields: PopupField[] }

const MAX_LABEL = 24

/**
 * The default order is the order the questions get asked in: where, when, what
 * kind, what it is, how to get in. `category` is off by default because the
 * pin's colour already says it — showing both spends a line on a fact the
 * reader has already had.
 */
export const DEFAULT_POPUP_FIELDS: PopupField[] = [
  { field: 'venue', label: 'Where', visible: true },
  { field: 'when', label: 'When', visible: true },
  { field: 'summary', label: 'About', visible: true },
  { field: 'offer', label: 'Entry', visible: true },
  { field: 'category', label: 'Category', visible: false },
]

export const defaultPopupConfig = (): PopupConfig => ({
  fields: DEFAULT_POPUP_FIELDS.map((field) => ({ ...field })),
})

const isFieldKey = (value: unknown): value is PopupFieldKey =>
  typeof value === 'string' && (POPUP_FIELDS as readonly string[]).includes(value)

/**
 * Reads whatever was stored or sent and returns a whole, ordered config.
 *
 * Total by construction: unknown fields are dropped, missing ones are appended
 * hidden in their default order, duplicates keep the first mention, and a label
 * that is blank or too long falls back to the default. A stored config is JSON
 * from an older version of the wizard and cannot be trusted to be current —
 * the same reasoning as `reviveListing` in the draft store.
 *
 * `null` in means "never customised", and comes back as the defaults rather
 * than as an empty popup: a listing that has not been fiddled with shows the
 * sensible thing.
 */
export function parsePopupConfig(raw: unknown): PopupConfig {
  const candidate = typeof raw === 'string'
    ? (() => {
        try { return JSON.parse(raw) } catch (cause) {
          swallowed('popup_config_parse', cause)
          return null
        }
      })()
    : raw

  const entries = candidate && typeof candidate === 'object' && Array.isArray((candidate as { fields?: unknown }).fields)
    ? (candidate as { fields: unknown[] }).fields
    : null
  if (!entries) return defaultPopupConfig()

  const seen = new Set<PopupFieldKey>()
  const fields: PopupField[] = []

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (!isFieldKey(row.field) || seen.has(row.field)) continue
    seen.add(row.field)

    const fallback = DEFAULT_POPUP_FIELDS.find((field) => field.field === row.field)!
    const label = typeof row.label === 'string' ? row.label.trim() : ''
    fields.push({
      field: row.field,
      label: label === '' || label.length > MAX_LABEL ? fallback.label : label,
      visible: row.visible !== false,
    })
  }

  // Anything the client never mentioned is appended hidden, so a field added
  // to the set later does not silently turn itself on for every existing
  // listing — and is still there to be switched on.
  for (const field of DEFAULT_POPUP_FIELDS) {
    if (!seen.has(field.field)) fields.push({ ...field, visible: false })
  }

  return { fields }
}

/** Whether this config is the default one, so the UI can say "not customised". */
export function isDefaultPopupConfig(config: PopupConfig): boolean {
  const defaults = defaultPopupConfig().fields
  return config.fields.length === defaults.length
    && config.fields.every((field, index) => {
      const expected = defaults[index]!
      return field.field === expected.field
        && field.label === expected.label
        && field.visible === expected.visible
    })
}

/**
 * What to store. A config that is the default is stored as `null` rather than
 * as a copy of the defaults — so "reset to defaults" is a clearing, and a
 * later change to the defaults reaches every listing that never overrode them.
 */
export function serialisePopupConfig(config: PopupConfig): PopupConfig | null {
  return isDefaultPopupConfig(config) ? null : config
}
