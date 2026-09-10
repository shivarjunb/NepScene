#!/usr/bin/env node
/**
 * Post-deploy smoke test (#11).
 *
 * Six things, in the order they break: the Worker is alive and is the
 * environment we think it is, the catalog read path answers and respects its
 * bound, the shell serves, its social card is absolute and resolves, the public
 * pages are actually server-rendered, and the crawl surface answers.
 *
 * The rendering check earns its place because that failure is silent by design
 * (#45): when a render throws, the Worker serves the static shell, so the site
 * still works and only the crawler's copy is gone. A build that lost server
 * rendering — a JSX transform mismatch, a missing `dist/ssr/server.js` — would
 * deploy green and stay that way until someone thought to look at a rank.
 *
 * The environment assertion matters more than it looks. Assets are served from
 * the edge with an SPA fallback, so a request for an unmatched path returns
 * index.html with a 200 — the earlier smoke test hit `/health` (no `/api`) and
 * would have passed against a completely dead Worker.
 *
 * Usage: node scripts/smoke.mjs https://nepscene-staging.example.workers.dev staging
 */
const [base, expectedEnv] = process.argv.slice(2)

if (!base || !expectedEnv) {
  console.error('usage: node scripts/smoke.mjs <base-url> <environment>')
  process.exit(2)
}

const failures = []
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name} — ${detail}`)
    failures.push(name)
  }
}

const get = async (path, accept = 'application/json') => {
  const response = await fetch(`${base}${path}`, { headers: { accept } })
  return { status: response.status, body: await response.text() }
}

console.log(`Smoke testing ${base} (expecting environment "${expectedEnv}")`)

// 1. The Worker is alive, and it is the right one.
const health = await get('/api/health')
check('health responds 200', health.status === 200, `got ${health.status}`)
let reported = null
try {
  reported = JSON.parse(health.body).environment
} catch {
  check('health returns JSON', false, `body starts: ${health.body.slice(0, 60)}`)
}
check(
  `health reports environment "${expectedEnv}"`,
  reported === expectedEnv,
  `reported "${reported}" — wrong environment deployed, or the SPA fallback answered`,
)

// 2. The catalog read path answers and stays bounded.
const catalog = await get('/api/catalog/listings?limit=5')
check('catalog responds 200', catalog.status === 200, `got ${catalog.status}`)
try {
  const { data, page } = JSON.parse(catalog.body)
  check('catalog returns a data array', Array.isArray(data), `got ${typeof data}`)
  check('catalog respects the limit', Array.isArray(data) && data.length <= 5, `got ${data?.length} rows`)
  check('catalog reports its page bound', page?.limit === 5, `page.limit was ${page?.limit}`)
} catch {
  check('catalog returns JSON', false, `body starts: ${catalog.body.slice(0, 60)}`)
}

// 3. The SPA shell serves.
const shell = await get('/', 'text/html')
check('SPA shell responds 200', shell.status === 200, `got ${shell.status}`)
check('SPA shell has a root element', shell.body.includes('id="root"'), 'no #root in the document')

// 4. The social card is absolute and actually resolves (#19).
//
// Facebook, X and WhatsApp fetch og:image with no base URL. A relative path is
// not a broken image — it is no card at all, and nothing in the app ever
// notices. Both halves matter: absolute, and reachable.
const ogImage = /<meta\s+property="og:image"\s+content="([^"]+)"/.exec(shell.body)?.[1] ?? null
check('social card URL is present', ogImage !== null, 'no og:image meta tag in the shell')
check(
  'social card URL is absolute',
  ogImage !== null && /^https:\/\//.test(ogImage),
  `og:image is "${ogImage}" — crawlers resolve it against nothing and render no card`,
)
if (ogImage && /^https:\/\//.test(ogImage)) {
  const card = await fetch(ogImage, { redirect: 'follow' })
  check('social card resolves', card.status === 200, `${ogImage} returned ${card.status}`)
  check(
    'social card is an image',
    (card.headers.get('content-type') ?? '').startsWith('image/'),
    `content-type was "${card.headers.get('content-type')}"`,
  )
}

// 5. The public pages are server-rendered, not merely served (#45).
const rendered = /<div id="root"[^>]*data-rendered="server"[^>]*>([\s\S]*?)<\/div>/.exec(shell.body)
check(
  'home is marked server-rendered',
  /data-rendered="server"/.test(shell.body),
  'no data-rendered marker — the render threw and the static shell was served',
)
check(
  'home has rendered content',
  (rendered?.[1]?.length ?? 0) > 500,
  `#root held ${rendered?.[1]?.length ?? 0} characters — the marker is there but nothing rendered`,
)

const listingHref = /href="(\/listings\/[a-z0-9-]+)"/.exec(shell.body)?.[1] ?? null
if (listingHref) {
  const listing = await get(listingHref, 'text/html')
  check(`${listingHref} responds 200`, listing.status === 200, `got ${listing.status}`)
  check(
    'a listing page is server-rendered',
    /data-rendered="server"/.test(listing.body),
    'the homepage rendered but a listing page did not',
  )
  check(
    'a listing page carries structured data',
    listing.body.includes('application/ld+json') && listing.body.includes('"@type":"Event"'),
    'no Event JSON-LD on the listing page',
  )
}

// 6. The crawl surface. On anything but production this asserts the *opposite*:
// a staging host that invites crawlers is the duplicate-content problem.
const robots = await get('/robots.txt', 'text/plain')
check('robots.txt responds 200', robots.status === 200, `got ${robots.status}`)
if (expectedEnv === 'production') {
  check(
    'robots.txt allows crawling and names the sitemap',
    robots.body.includes('Allow: /') && robots.body.includes('/sitemap.xml'),
    `body was: ${robots.body.slice(0, 80)}`,
  )
  const sitemap = await get('/sitemap.xml', 'application/xml')
  check('sitemap.xml responds 200', sitemap.status === 200, `got ${sitemap.status}`)
  check(
    'sitemap.xml is an index',
    sitemap.body.includes('<sitemapindex'),
    `body starts: ${sitemap.body.slice(0, 80)}`,
  )
} else {
  check(
    'robots.txt keeps this deployment out of the index',
    /Disallow: \/\s*$/m.test(robots.body) && !robots.body.includes('Allow: /'),
    `body was: ${robots.body.slice(0, 80)} — a non-production host must not invite crawlers`,
  )
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll smoke checks passed.')
