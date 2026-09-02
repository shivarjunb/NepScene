/**
 * The CI guards, as pure functions (#10).
 *
 * These live apart from the workflow so they can be tested against known-bad
 * fixtures rather than trusted. Nothing here touches the filesystem — the CLIs
 * in scripts/check-*.mjs do the reading and the exiting.
 */

/**
 * Migration files are forward-only and uniquely numbered (#12). WaahTickets
 * accumulated four duplicate prefixes (0009, 0010, 0016, 0019); two migrations
 * claiming the same number means the order they apply in is whatever the
 * filesystem felt like that day.
 *
 * @param {string[]} filenames
 * @returns {string[]} duplicated four-digit prefixes, sorted
 */
export function duplicateMigrationPrefixes(filenames) {
  const seen = new Map()
  for (const name of filenames) {
    const match = /^(\d{4})/.exec(name)
    if (!match) continue
    const prefix = match[1]
    seen.set(prefix, (seen.get(prefix) ?? 0) + 1)
  }
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([prefix]) => prefix)
    .sort()
}

/**
 * A migration whose number is lower than one already applied would be skipped
 * silently by `wrangler d1 migrations apply`. Numbering must not go backwards
 * within a single change, so the set is required to be gapless from 0001.
 *
 * @param {string[]} filenames
 * @returns {number[]} missing numbers between 1 and the highest present
 */
export function missingMigrationNumbers(filenames) {
  const numbers = filenames
    .map((name) => /^(\d{4})/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
  if (numbers.length === 0) return []
  const highest = Math.max(...numbers)
  const present = new Set(numbers)
  const missing = []
  for (let n = 1; n <= highest; n++) if (!present.has(n)) missing.push(n)
  return missing
}

/**
 * NepScene renders offers; it never computes them (docs/SCOPE.md). This is a
 * warning rather than a gate — rendering a `price_from` is legitimate — and it
 * exists to make boundary erosion visible in review instead of discovered in a
 * year when the two products have quietly merged again.
 */
export const COMMERCE_TERMS = [
  'checkout',
  'cart_hold',
  'order_items',
  'payment_provider',
  'coupon_redemption',
  'commission_ledger',
  'payout_batch',
]

/**
 * camelCase is how commerce would actually arrive: `createCheckout`, not
 * `checkout`. A plain word-boundary match misses it, so identifiers are split
 * at the case transition before matching — `createCheckout` becomes
 * `create Checkout`, while `checkoutish` stays one word and is correctly
 * ignored.
 *
 * @param {string} text file contents
 * @param {string} file path, for reporting
 * @returns {{file: string, line: number, term: string, text: string}[]}
 */
export function commerceHits(text, file) {
  // Both sides are reduced to space-separated words, so one term catches every
  // casing the same concept arrives in: `order_items`, `orderItems` and
  // `OrderItemsRow` all normalise to `order items`.
  const pattern = new RegExp(`\\b(${COMMERCE_TERMS.map((t) => t.replace(/_/g, ' ')).join('|')})\\b`, 'i')
  const normalise = (line) => line.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
  const hits = []
  text.split('\n').forEach((line, index) => {
    const match = pattern.exec(normalise(line))
    if (match) {
      const term = match[1].toLowerCase().replace(/ /g, '_')
      hits.push({ file, line: index + 1, term, text: line.trim() })
    }
  })
  return hits
}
