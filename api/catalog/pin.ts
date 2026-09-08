import type { CategoryRef, PinAppearance } from './types'

/**
 * Pin appearance (#22, and the default #32 customises on top of).
 *
 * There is no `map_pin_icon` column any more. WaahTickets carried one and paid
 * for it twice: the map needed a separate `pinCategory` concept to reconcile
 * the icon with the filter chips, and the two still drifted apart because
 * nothing kept them in step. Appearance is a *function* of the primary
 * category here, so the chip and the pin cannot disagree — there is only one
 * value, read twice.
 */

/**
 * What a listing with no category looks like. An announcement legitimately has
 * none, so this is a real case rather than a defensive one.
 */
export const DEFAULT_PIN: PinAppearance = {
  icon: 'MapPin',
  color: '#64748b', // --color-neutral-500; deliberately not one of the twelve
  category: null,
}

/**
 * The primary category is the one the pin comes from. Ordering is guaranteed
 * by the query (primary first) and uniqueness by the partial index in
 * migration 0005, so "the first one" is a definition, not a guess.
 */
export function resolvePin(categories: CategoryRef[]): PinAppearance {
  const primary = categories.find((category) => category.is_primary) ?? categories[0]
  if (!primary) return DEFAULT_PIN
  return {
    icon: primary.icon ?? DEFAULT_PIN.icon,
    color: primary.color ?? DEFAULT_PIN.color,
    category: primary.slug,
  }
}
