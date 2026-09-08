import type { Bootstrap, Category, Listing } from './catalog'

/**
 * The row rules (#41).
 *
 * WaahTickets curated its homepage rails from a hand-maintained list of event
 * IDs in `app_settings`. That does not survive past a few dozen events and it
 * silently empties whenever a curated event finishes. Every row here is a rule
 * over the catalogue instead: nothing is named, so nothing goes stale.
 *
 * Pure and DOM-free on purpose — these run in workerd under tests/unit, which
 * is where the selection logic is actually pinned down.
 */

const NEPAL = 'Asia/Kathmandu'

// Constructed once: Intl formatters are expensive and these are hot.
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: NEPAL, year: 'numeric', month: '2-digit', day: '2-digit',
})
const weekdayFormat = new Intl.DateTimeFormat('en-US', { timeZone: NEPAL, weekday: 'short' })

/** The calendar day a moment falls on *in Nepal*, as YYYY-MM-DD. */
export const nepalDay = (iso: string | Date) => dayFormat.format(new Date(iso))

export const nepalWeekday = (iso: string | Date) => weekdayFormat.format(new Date(iso))

/**
 * Nepal's weekly holiday is Saturday, not Sunday, and Friday evening is when
 * things start. "This weekend" is therefore Friday–Saturday, not Saturday–Sunday
 * — the row would otherwise point at a working Sunday and miss the Friday night
 * it should be selling.
 *
 * Returned as calendar days rather than an instant range so the comparison
 * never has to do UTC+05:45 arithmetic.
 */
export function weekendDays(now: Date): string[] {
  const days = Array.from({ length: 8 }, (_, offset) => {
    const day = new Date(now.getTime() + offset * 86_400_000)
    return { day: nepalDay(day), weekday: nepalWeekday(day) }
  })

  const saturday = days.findIndex((entry) => entry.weekday === 'Sat')
  if (saturday === -1) return []

  const weekend = [days[saturday]!.day]
  // On a Saturday the Friday has already gone; the weekend is just today.
  const friday = days[saturday - 1]
  if (friday?.weekday === 'Fri') weekend.unshift(friday.day)
  return weekend
}

/** The most common non-null value, or undefined when there is nothing to count. */
function mostCommon<T, K extends string>(items: T[], key: (item: T) => K | null | undefined) {
  const counts = new Map<K, number>()
  for (const item of items) {
    const value = key(item)
    if (value == null) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  let best: { value: K; count: number } | undefined
  for (const [value, count] of counts) {
    // Ties break on the first seen, which is the API's order: soonest first.
    if (!best || count > best.count) best = { value, count }
  }
  return best?.value
}

export type Row = {
  id: string
  title: string
  /** Why these listings, in the user's words. Rendered, not just documented. */
  rule: string
  listings: Listing[]
  /** What to say when the rule matches nothing. */
  empty: string
  /** The filter this row corresponds to, for "see all". */
  href?: string
}

export function buildRows(bootstrap: Bootstrap, now: Date): Row[] {
  const { upcoming, featured, categories } = bootstrap
  const rows: Row[] = []

  rows.push({
    id: 'featured',
    title: 'Featured',
    rule: 'Picked out by the people running them',
    listings: featured,
    empty: 'Nothing is featured at the moment.',
  })

  const weekend = weekendDays(now)
  rows.push({
    id: 'weekend',
    title: 'This weekend',
    rule: 'Friday and Saturday — Nepal’s weekend, not the calendar’s',
    listings: upcoming.filter((listing) => weekend.includes(nepalDay(listing.starts_at))),
    empty: 'Nothing on this Friday or Saturday yet.',
  })

  const city = mostCommon(upcoming, (listing) => listing.venue?.city)
  if (city) {
    rows.push({
      id: 'city',
      title: `In ${city}`,
      rule: 'The city with the most on right now',
      listings: upcoming.filter((listing) => listing.venue?.city === city),
      empty: `Nothing coming up in ${city}.`,
      href: `/?city=${encodeURIComponent(city)}`,
    })
  }

  rows.push({
    id: 'free',
    title: 'Free entry',
    rule: 'Listings that cost nothing to turn up to',
    listings: upcoming.filter((listing) => listing.listing_type === 'free'),
    empty: 'No free listings coming up.',
  })

  const categorySlug = mostCommon(upcoming, (listing) => listing.categories[0]?.slug)
  const category = categories.find((entry) => entry.slug === categorySlug)
  if (category) {
    rows.push({
      id: `category-${category.slug}`,
      title: category.name,
      rule: 'The busiest category this month',
      listings: upcoming.filter((listing) =>
        listing.categories.some((entry) => entry.slug === category.slug)),
      empty: `Nothing coming up under ${category.name}.`,
      href: `/?category=${encodeURIComponent(category.slug)}`,
    })
  }

  return rows
}

/** Categories worth showing as entry points: the ones that lead somewhere. */
export function entryCategories(categories: Category[]): Category[] {
  return categories
    .filter((category) => category.upcoming_listing_count > 0)
    .sort((a, b) => b.upcoming_listing_count - a.upcoming_listing_count)
}
