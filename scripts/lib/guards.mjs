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

/**
 * Credentials must never reach a commit (#13). GitHub push protection is on and
 * genuinely blocks — a Slack token and a Stripe key were both refused when this
 * guard was written — but it does not cover everything, and the gap happens to
 * sit exactly where NepScene is most exposed: a Google API key in the
 * `AIza…` shape pushed cleanly. That is the shape of the Maps key, the one
 * credential in this project that is a build-time public value a developer is
 * most likely to paste somewhere for a moment "just to see the map work".
 *
 * So this is not a second opinion on push protection. It covers what push
 * protection demonstrably does not, in the repository where it matters.
 *
 * Two rules, because the two failure modes are different:
 *
 *  - by shape, for credentials with a distinctive format; and
 *  - by name, for credentials that look like any other random string. A
 *    Cloudflare API token cannot be recognised on sight, but
 *    `CLOUDFLARE_API_TOKEN=<forty characters>` can.
 *
 * A line carrying `secret-guard:allow` is skipped, which is how the patterns
 * below can name the shapes they match without matching themselves.
 */

/** Credentials recognisable by shape alone. */
const CREDENTIAL_SHAPES = [
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ }, // secret-guard:allow
  { name: 'Google OAuth client secret', pattern: /\bGOCSPX-[0-9A-Za-z_-]{28}\b/ }, // secret-guard:allow
]

/** Credentials recognisable only by the name they are assigned to. */
const CREDENTIAL_NAMES = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'GOOGLE_CLIENT_SECRET',
  'VITE_GOOGLE_MAPS_API_KEY',
]

const NAMED_ASSIGNMENT = new RegExp(`\\b(${CREDENTIAL_NAMES.join('|')})\\s*[:=]\\s*(.*)$`)

/**
 * A credential is long and has no spaces. Everything else assigned to one of
 * those names in a real repository is not one: `GOOGLE_CLIENT_SECRET: string`
 * is a type, `= ''` is a default, `${{ secrets.X }}` is a reference, and
 * `'test-secret'` is a fixture. Rather than enumerate those, require the value
 * to look like the thing being guarded against.
 *
 * Sixteen characters is comfortably below the real ones — a Cloudflare API
 * token is 40, a Google client secret 35, an account ID 32 — and comfortably
 * above the fixtures. A guard that fires on type annotations is a guard someone
 * deletes, and then the real leak goes through too.
 *
 * @param {string} raw the text to the right of the `=` or `:`
 * @returns {boolean}
 */
function looksLikeCredentialValue(raw) {
  // Take the first bare token: strips quotes, trailing commas, `;`, comments.
  const value = raw.trim().replace(/^["'`]/, '').split(/["'`,;\s]/)[0] ?? ''
  if (value.length < 16) return false
  if (!/^[A-Za-z0-9_\-.~+/=]+$/.test(value)) return false
  // A `${{ secrets.X }}` or `$X` reference needs no rule of its own: the `$`
  // and `{` fail the alphabet test above, and `%X%` fails on length.
  if (/^(your|placeholder|changeme|change-me|todo|example|dummy|fake|redacted)/i.test(value)) return false
  // `****************` — a redaction, which is what a log or a doc shows.
  if (/^(.)\1*$/.test(value)) return false
  return true
}

/**
 * @param {string} text file contents
 * @param {string} file path, for reporting
 * @returns {{file: string, line: number, kind: string, text: string}[]}
 */
export function credentialHits(text, file) {
  const hits = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.includes('secret-guard:allow')) continue
    const shape = CREDENTIAL_SHAPES.find(({ pattern }) => pattern.test(line))
    if (shape) {
      hits.push({ file, line: index + 1, kind: shape.name, text: line.trim() })
      continue // the name rule is the fallback for what has no shape; one line, one hit
    }
    const assignment = NAMED_ASSIGNMENT.exec(line)
    if (assignment && looksLikeCredentialValue(assignment[2])) {
      hits.push({ file, line: index + 1, kind: `${assignment[1]} with a value`, text: line.trim() })
    }
  }
  return hits
}
