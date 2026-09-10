/**
 * The date buckets a search offers as facets (#42).
 *
 * Every boundary is a Kathmandu boundary. A UTC "today" ends at 05:45 the
 * following morning in Nepal, which would file a Friday night gig under
 * Saturday — the same mistake the view counter avoids (migration 0011), for
 * the same reason.
 *
 * Buckets are cumulative and therefore mutually exclusive: a listing lands in
 * the first one whose end it falls before, so the counts sum to the result
 * set. The bucket also carries the `from`/`to` it corresponds to, so the
 * client filters by exactly the window the count was taken over rather than
 * recomputing a boundary and disagreeing by 5 hours 45 minutes.
 */
const KATHMANDU_OFFSET_MS = 5.75 * 60 * 60 * 1000
const DAY_MS = 86_400_000

export type WhenBucket = {
  value: 'today' | 'tomorrow' | 'this-week' | 'this-month' | 'later'
  label: string
  /** Inclusive lower bound on starts_at; null on the first bucket, which has
   *  to keep listings that started before now and are still running. */
  from: string | null
  /** Exclusive upper bound; null on the last, which is unbounded. */
  to: string | null
}

/** Midnight in Kathmandu, `days` days after the day `at` falls on, as UTC. */
function kathmanduMidnight(at: Date, days: number): Date {
  const local = new Date(at.getTime() + KATHMANDU_OFFSET_MS)
  const startOfLocalDay = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
  )
  return new Date(startOfLocalDay + days * DAY_MS - KATHMANDU_OFFSET_MS)
}

/**
 * The end of the week is the end of Saturday, because Nepal's weekly holiday
 * is Saturday — the same definition the homepage's weekend row uses
 * (app/lib/rows.ts), and one the calendar's Sunday-start would get wrong.
 */
function endOfWeek(at: Date): Date {
  const local = new Date(at.getTime() + KATHMANDU_OFFSET_MS)
  const daysToSaturday = (6 - local.getUTCDay() + 7) % 7
  return kathmanduMidnight(at, daysToSaturday + 1)
}

function endOfMonth(at: Date): Date {
  const local = new Date(at.getTime() + KATHMANDU_OFFSET_MS)
  const firstOfNext = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1)
  return new Date(firstOfNext - KATHMANDU_OFFSET_MS)
}

export function whenBuckets(now: Date): WhenBucket[] {
  const today = kathmanduMidnight(now, 1).toISOString()
  const tomorrow = kathmanduMidnight(now, 2).toISOString()
  const week = endOfWeek(now).toISOString()
  const month = endOfMonth(now).toISOString()

  // A boundary that has already been passed by a longer one collapses: on a
  // Friday, "this week" ends when "tomorrow" does, and offering both would
  // show a facet that can never have a count.
  //
  // The chain is rebuilt after the collapse rather than filtered in place.
  // The facet SQL buckets a row by the first `to` it falls before, so a
  // surviving bucket that kept the *dropped* neighbour's `from` would count
  // one window and link to another — a chip saying 6 that leads to 2.
  const boundaries: { value: WhenBucket['value']; label: string; to: string | null }[] = [
    { value: 'today', label: 'Today', to: today },
    { value: 'tomorrow', label: 'Tomorrow', to: tomorrow },
    { value: 'this-week', label: 'This week', to: week },
    { value: 'this-month', label: 'This month', to: month },
    { value: 'later', label: 'Later', to: null },
  ]

  const buckets: WhenBucket[] = []
  let previous: string | null = null
  for (const boundary of boundaries) {
    // Nothing can fall between the last boundary and this one.
    if (boundary.to !== null && previous !== null && boundary.to <= previous) continue
    buckets.push({ value: boundary.value, label: boundary.label, from: previous, to: boundary.to })
    previous = boundary.to
  }
  return buckets
}
