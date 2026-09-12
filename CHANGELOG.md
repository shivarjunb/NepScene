# Changelog

All notable changes to NepScene are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **The public site is server-rendered (#45).** Every page a reader or a crawler
  can land on now arrives as a document with its content already in it — the
  homepage, listing pages, venue, organizer and artist pages, and the two index
  pages. With JavaScript switched off, a listing still names its date, its venue
  and its price.
  - **One React tree, two runtimes.** `app/Root.tsx` is rendered by
    `renderToString` in the Worker and hydrated by the same components in the
    browser. A second, simpler server template is the obvious shortcut and the
    one that goes wrong quietly: two renderers that agree today and diverge on
    the next change, with the divergence visible only to crawlers. What the
    router needed in order to run in a Worker was to take its opening location
    as a prop instead of reading `window` — that was the whole of it.
  - **The shell is the built `index.html`, rewritten — not a template in the
    Worker.** Vite writes the hashed asset names into that document, along with
    the theme script that has to run before first paint (#17); a hand-built copy
    in the Worker would be a second copy of all of it, going stale on every
    build. `HTMLRewriter` streams over the asset and replaces exactly what is
    per-page: title, description, social card, canonical, `hreflang`, structured
    data and the contents of `#root`.
  - **The rows the server rendered from reach the client, so nothing is fetched
    twice.** They are inlined into the document and read by the same
    `useResource` hook that would otherwise request them, skipping exactly one
    effect run. A page that renders with data and then immediately refetches it
    has paid for server rendering and kept the SPA's latency. They travel in
    React context rather than a module global, because one isolate serves
    concurrent requests and "the current page's data" in a variable is a
    cross-request leak waiting for traffic.
  - **A rendering failure serves the SPA rather than an error.** A transient D1
    problem then costs one round trip and the crawler's copy of that page, and
    the shell still boots and paints. The alternative turns a database blip into
    a blank 500 on every public page.
  - **Only the pages a crawler should land on are rendered.** The wizard, the
    dashboard and the moderation queue need a session, are `noindex` by nature,
    and gain nothing for the round trip — they fall through to the SPA exactly
    as before. `/search` is rendered for people without JavaScript but served
    `noindex`, so no crawler makes the Worker run a ranked search per URL it
    invents.
  - **Schema.org `Event`, `Place`, `Organization`, `BreadcrumbList` and
    `WebSite`**, built from the same rows the page renders. Empty fields are
    dropped rather than emitted as null: an `Event` with no `offers` is better
    than one asserting a price it does not have.
  - **Sitemaps are generated, not stored.** A stored sitemap goes stale
    silently, and the failure mode is that newly published listings are simply
    never crawled — so `/sitemap.xml` is a read like any other. It is an index
    over segments capped at the protocol's 50,000 URLs, each entry declaring its
    Nepali alternate. `robots.txt` disallows everything outside production,
    because a staging deployment that gets indexed is a duplicate-content
    problem that outlives the branch.
  - **Nepali became addressable.** `?lang=ne` renders the document in Nepali
    with `lang="ne"` and `hreflang` alternates in both directions, which is what
    makes the translated content in #46 visible to a crawler at all. It does not
    override a reader's stored choice — precedence is stored, then URL, then
    browser — so a link shared in Nepali does not permanently switch somebody
    who had chosen English.
  - **The SSR bundle is prebuilt by Vite**; `npm run build` now emits
    `dist/ssr/server.js` beside the client. `wrangler dev` passes esbuild its own
    JSX factory unconditionally, which forces the classic transform and makes
    every component throw `React is not defined` at runtime — silently, because
    a rendering failure falls back to the shell, leaving a site that looks
    exactly like the one before #45. Prebuilding is what avoids it, and
    `tests/e2e/rendering.spec.ts` runs against a real `wrangler dev` for the same
    reason: Vite's preview server renders nothing, so a test of rendering there
    would pass while proving nothing.
- **Server-side search (#42).** A rebuild rather than a port: WaahTickets
  filtered an already-downloaded array in the browser, which is why its search
  only ever worked at fifty events. `GET /api/catalog/search` now returns ranked
  results, facet counts and — when it has to — a correction, and
  `GET /api/catalog/suggest` answers as you type.
  - **Ranking is a blend, and it is a pure function.** Text match, date
    proximity, distance and popularity, weighted, in `api/catalog/ranking.ts`
    rather than in an ORDER BY expression — because "a match tomorrow beats one
    in six months" is a claim that should be arguable in a test, and a query
    string cannot be. It runs over a bounded candidate set, and the ceiling that
    implies is stated where it is applied.
  - **Nepali place names are a table, not an algorithm.** One place arrives as
    Pokhara and Pokhra, Birgunj and Birganj, Lalitpur and Patan and Yala — and
    the hard cases are not phonetic, so nothing derives them. Thirty-odd groups
    cover where events happen, each indexed by its *folded* spelling, which is
    what makes the two directions in #46 one mechanism: `काठमाडौं` folds into
    the Kathmandu group and expands back out to the Devanagari spelling that
    finds a Devanagari title.
  - **Typo tolerance costs nothing on the requests that did not need it.** A
    query that found something is never second-guessed; a query that found
    nothing is corrected against the catalogue's own vocabulary — proper nouns,
    where a dictionary is worse than useless — and run once more. That is the
    only path that spends a second D1 round trip.
  - **Facet counts describe the whole matching set**, not the page: a city facet
    that said 12 on page one and 4 on page two would be describing the page. The
    date facets carry the exact window they were counted over, so the chip that
    says 8 leads to 8 listings rather than to a boundary the client recomputed.
  - A zero-result search offers near-misses, and when the query resembles
    nothing at all it offers the broadest entry points there are rather than an
    apology.
- **Listing pages (#43).** `/listings/:slug` is a real, addressable, shareable
  page: description, media, artists, tags, the venue on a map, the organizer,
  related listings, WhatsApp-first sharing and an iCalendar download.
  - **The offer section degrades and says so.** A ticketed listing whose offer
    could not be resolved renders everything above the buy button and states
    that ticket details are unavailable — a rendered state rather than a missing
    element, so it is visible in a screenshot when it happens. Discovery is
    never held hostage by commerce being up (docs/SCOPE.md).
  - Add-to-calendar writes UTC instants rather than a local time plus a
    `VTIMEZONE`: the same instant everywhere, converted by the reader's own
    client, with no copy of Nepal's tz rules to keep right. An all-day listing
    is a `VALUE=DATE` event, because a timestamped midnight lands as a
    Tuesday-night alarm for somebody in London.
  - The view beacon now waits for the record. Counting a view for a slug the
    catalogue has never heard of taught the dashboard that a mistyped URL is a
    visitor.
- **Venue, organizer and artist pages (#44),** with index pages for the first
  two. Each answers the same two questions — what is on, and what has been — in
  one round trip, and **a venue with nothing coming up shows its past rather
  than an empty page**, because a venue between seasons is one people are still
  looking up and "nothing here" reads as "closed". An artist gets a page once
  they are on more than one listing, and the same threshold decides whether a
  listing links to it, read from one place rather than guessed at in two.
- **Nepali (#46).** The public interface, the listing content, the search and
  the dates.
  - One string table with both languages on each line, so a missing translation
    is a type error rather than a key rendered in production. The authoring
    wizard and the moderation queue are *not* translated — they are tools for
    people who chose to list events here, not the audience #46 exists for — and
    that is stated in the file rather than discovered later.
  - Language is state rather than a route: switching keeps the page, the
    filters and the scroll position, with no `/ne/` prefix to lose them. #45
    then added `?lang=ne` on top as a crawlable entry point — the document a
    crawler is handed, not the state a reader is put into, which is why a
    stored choice still outranks it.
  - `title_ne`, `summary_ne` and `description_ne` on listings (migration 0013),
    authored behind a disclosure in the wizard, matched by search beside their
    English counterparts, and rendered with a `lang` attribute where the
    fallback kicked in — so a screen reader does not read English in a Nepali
    voice.
  - **Bikram Sambat, from the published table.** There is no arithmetic rule for
    it: months begin at sankranti and vary between 29 and 32 days in a sequence
    that has to be observed. BS 2070–2090 is carried, verified against Hamro
    Patro, and anything outside that window falls back to the Gregorian date
    rather than extrapolating.
  - Gregorian dates in Nepali are formatted from a table rather than through
    `Intl`, because a browser with a trimmed ICU falls back to English silently
    — which would put an English date under a Nepali heading on exactly the
    devices this feature is for.
- Account management (#29): `POST /api/auth/email/change`, `GET /api/auth/me/export`
  and `DELETE /api/auth/me`.
  - Changing an address does not change it. The new one waits in
    `users.pending_email` until a token sent *to it* comes back, so the change
    proves control of the address being claimed rather than of the session
    making the claim. Confirming it signs every session out — the mailbox that
    receives password resets has just moved.
  - Deletion follows one rule: what was published stays published, what was
    never published goes. Published and archived listings survive with
    `created_by` cleared, falling to the organization's other members or to
    editors; drafts and submissions awaiting review are deleted with their
    images. The user row goes rather than being flagged inactive, and audit
    entries keep their action and role while losing the actor. Confirmation —
    the current password, or typing the address on a Google-only account — is
    required, because a session is not consent.
  - The export returns the columns under the names they are stored under, so it
    can be checked against what someone believes is held. The password digest is
    the one omission.
- The media pipeline generates and serves derivatives (#25). Images are stored
  under a key derived from their own SHA-256, so the same file uploaded twice is
  one object and `immutable` on the read path stops being a promise the
  application cannot keep. Derivatives are encoded by the browser at four widths
  (320/640/960/1440, never above the original) and **verified** on the way in —
  format, size, width-on-the-ladder and aspect ratio are all read from each
  file's own header, so nothing the request *claims* is trusted. The catalogue
  serves them as a per-format `srcset`, AVIF then WebP then the original, with
  `aspect_ratio` so the box exists before the bytes do. Feed rows carry a
  `cover` with the same shape: without derivatives on the summary a card on a
  phone downloads the full-size banner, which is the WaahTickets behaviour this
  replaces
- `POST /api/author/media/sweep` (admin, dry-run by default) reclaims R2 objects
  no row references. Every write puts bytes before the row that points at them —
  the other order leaves broken images — so a request that dies in between has
  to be collected by something (#25)
- `ResponsiveImage` renders a `<picture>` with `sizes`, intrinsic dimensions and
  lazy loading. `sizes` is required by the component's own types: a srcset
  without it is decoration, because the browser assumes full-viewport width and
  fetches the widest rung on a phone (#25)
- Free-form tags alongside the fixed categories: `tags` and `listing_tags`, a
  `tag=` filter on the feed and search, `GET /api/catalog/tags`, and tags on the
  listing detail. Categories stay closed and seeded so a filter chip means
  something; tags absorb `holi`, `open-mic` and `kids-welcome` without a
  migration each time. Spellings normalise through the same slug rules as URLs,
  so `Open Mic`, `open mic` and `Open-Mic` are one tag rather than three
  half-empty browse pages (#22)
- An `artist=` filter on the feed, so the listing-to-artist relationship
  resolves in both directions rather than only outwards from a listing (#22)
- `npm run ci:guards` fails the build on a committed credential
  (`scripts/check-secrets.mjs`). GitHub push protection is on and does block —
  a Slack token and a Stripe key were both refused — but a Google API key in the
  `AIza…` shape pushed to this repository cleanly, and that is the shape of the
  Maps key. The guard covers what push protection does not: by format for the
  Google credentials, by variable name for tokens no regex can recognise on
  sight. It reads `git ls-files`, so a gitignored `.dev.vars` is not flagged (#13)

### Changed
- **The first paint no longer carries the tools (#39).** The listing wizard, the
  organizer dashboard, the moderation queue, the component gallery and the map
  itself each arrive in their own chunk the first time a page asks for them;
  everything else — the public pages that are the first paint — stays in the
  entry. First paint drops from 120 KB to 96.5 KB gzipped, and NepScene's own
  code on it is 35 KB, inside #39's 40 KB target. React DOM is 55 KB on its
  own, which is why the target is still recorded as unmet rather than
  redefined: what is left is the choice of renderer, not a build setting.
  `scripts/check-budget.mjs` reads the built shell to measure what it actually
  loads before painting, and ratchets the deferred chunks separately so weight
  cannot leave the first paint by hiding in one. Deferral is `app/lib/deferred.tsx`
  rather than `React.lazy`: the server renders with `renderToString`, which
  writes a suspended boundary's fallback and reports the suspension as an error;
  `deferred()` renders the same fallback on the server and on the first client
  render, so the map's frame hydrates cleanly on the homepage.
- The Catalog API's query builder binds every value **once**, by number, and
  matches text against a haystack computed once per row inside a `MATERIALIZED`
  CTE. Both are forced rather than chosen: D1 refuses more than a hundred bound
  variables and more than five terms in a compound SELECT, and the obvious shape
  cost 114ms for candidates and 664ms for facets at ten thousand listings.
  Both are now under 35ms (docs/ARCHITECTURE.md).
- `CategoryRef` carries `name_ne`, so a chip, a card, a pin popup and a filter
  are all in the reader's language rather than only the ones that happened to
  fetch the taxonomy.
- `fetchFeed` no longer takes a centre. `/listings` has no geography and
  `/search` applies the circle itself while ranking, rather than two places
  knowing how to turn a box into a radius.
- Coverage thresholds ratcheted to the new floor (94/82/97/96).
- `radius_km` is applied in SQL as a circle rather than only as the bounding box
  around it. A box is 27% larger than the circle it contains, so a radius that
  was only a prefilter returned listings beyond it — and, once the facet counts
  moved into the same query, described a set the reader was not being shown.
  SQLite has no trigonometry we can rely on across D1 builds, so the comparison
  is the flat-earth one with the two scale factors precomputed: metres out at
  Nepal's latitudes, and the same WHERE for the rows and the counts.
- All-day calendar exports end on the day *after* the last one. `DTEND` is
  exclusive for a date-valued event, and passing `ends_at` through unchanged
  made a one-day listing zero-length — dropped outright by most clients — and a
  three-day festival two days long.
- **Breaking (Catalog API).** `MediaItem` gains `sources`, `aspect_ratio` and a
  `cover` on every listing summary; uploads now reject an image whose header
  will not parse, because a picture with no intrinsic size cannot reserve a box
  and layout shift is what a reader actually notices (#25)
- **Breaking (Catalog API).** Map pin appearance is derived from the primary
  category instead of stored: `listings.map_pin_icon` is dropped and listings
  carry `pin: { icon, color, category }`, computed on every read. WaahTickets
  let an author set a pin icon independently of the event's type, and paid for
  it twice — the map needed a separate `pinCategory` concept to reconcile the
  icon with the filter chips, and the two drifted anyway. A partial unique index
  makes "the primary category" a function rather than a convention, so a pin's
  colour can no longer depend on row order. The WaahTickets importer reports the
  events whose stored icon disagreed with their type rather than carrying the
  disagreement across (#22, and the default #32 customises on top of)

### Fixed
- The social card is absolute. `og:image` was a relative `/brand/og-card.png`, and
  Facebook, X and WhatsApp fetch that URL with no base — the result is not a broken
  image but no preview card at all, which nothing in the application ever notices.
  The origin is injected at build time per environment (`VITE_PUBLIC_ORIGIN`), and
  `scripts/smoke.mjs` now fails a deploy whose card is relative or does not resolve
  (#19)
- The production promotion gate now runs before the approval gate, not after it.
  The check that an unverified SHA had passed staging lived inside the job that
  declares `environment: production`, and GitHub holds such a job at the approval
  gate before any step runs — so the refusal could only fire once a reviewer had
  already approved the promotion. Split into an ungated `gate` job that `promote`
  needs, and granted `actions: read` so the run-history query it depends on cannot
  fail for a permissions reason and be mistaken for a refusal (#11)

## [0.1.0] — 2026-09-02

First release. Everything below reached `main` in one merge (#54): the scaffold,
the design system, the catalogue core and Catalog API v1, identity and roles, the
three Cloudflare environments, and a delivery pipeline that runs.

### Added
- Application scaffold: Worker (Hono) + React SPA, per-environment Cloudflare
  bindings, migration pipeline and a Vitest harness that runs integration tests
  over real HTTP against a real local D1 (#9)
- Catalogue schema: listings with `listing_type` and `source`, venues as
  canonical entities, organizations, artists, categories, media and slug
  history (#20, #21, #22, #24, #25)
- Catalog API v1 — listings, listing detail, venues, venue detail, organizers,
  categories, search and a single-request homepage bootstrap. Bounded by a hard
  page cap, keyset-paginated and upcoming by default (#23)
- Edge-first read path: Cache API responses keyed by a KV version stamp, D1
  read replication via the Sessions API, and an `x-d1-round-trips` header on
  every response so the round-trip budget is measurable (#23)
- `/api/cache/status` probes the cache, KV and D1 with live round trips and
  reports measured latency, rather than reporting that an env var is set
- Demo catalogue seed covering every listing type and source, with dates
  relative to `now` so it never becomes a catalogue of finished events (#26)
- Accounts: email and password sign-in (PBKDF2-SHA256 via WebCrypto), Google
  sign-in over the authorization code flow with PKCE, opaque session cookies
  stored only as their SHA-256, email verification, and per-IP rate limiting on
  credential endpoints (#27)
- Roles and permissions: visitor, organizer, editor and admin resolved through a
  permission matrix rather than role checks in handlers (#28)
- Media upload and delete on R2, scoped by listing ownership or organization
  membership, with alt text required at the point of upload, and intrinsic
  dimensions read from the file header so the client can reserve space (#25)
- Publication workflow: submit, publish, reject, archive and unpublish, with
  the legal transitions enforced in the UPDATE itself and every move recorded
  in an audit trail (#20, #23, #28)
- Devanagari transliteration for slugs — इन्द्र जात्रा becomes `indra-jatra`,
  including word-final schwa deletion and schwa retention after conjuncts (#24)
- Password reset and password change, both revoking every other session (#27)
- Role administration with an audit record of who changed what (#28)
- ESLint enforcing the catalog / author / identity module boundary (#9)
- OpenAPI 3.1 contract served at `/api/openapi.json`, with the integration
  tests validating real responses against it (#23)
- `scripts/seed-volume.mjs` — 10,000 listings in about three seconds, and
  `scripts/verify-catalogue.mjs` — referential integrity and anomaly reporting (#26)
- `scripts/import-waahtickets.mjs` — imports all 50 WaahTickets events and 47
  locations with no data loss, repairing one overnight end-time on the way in
  (#20, #21)
- Design token layer extracted from WaahTickets: purpose-named colour, spacing,
  type, radius, elevation, motion and a named z-index scale, with light and dark
  defined only at the semantic layer (#15)
- Core UI primitives — button, field, input, textarea, select, checkbox, card,
  badge, chip, alert, modal, tabs, spinner, skeleton — each keyboard operable,
  focus-visible and rendered in a gallery in every state (#16)
- Light and dark theming with an inline pre-paint script, an OS-follows-by-
  default preference, and reduced-motion support (#17)
- Application shell: sticky header, primary nav, mobile menu with a focus trap,
  skip link, correct landmarks and a footer, holding from 320px to 2560px (#18)
- NepScene brand identity: crimson accent, one mark used as favicon, app icon
  and wordmark lockup, and a rasterised social card (#19)
- Playwright browser suite covering keyboard operability, focus trapping,
  theme-on-first-paint and responsive behaviour at six widths
- WCAG 2.1 AA contrast enforced by a test that computes ratios from the token
  file, plus stylesheet checks that no component CSS carries a literal colour
  or a raw z-index
- Repository scaffold: product scope, architecture, extraction plan and ways of working
- DevOps pipeline: CI, per-PR previews, staging on merge, gated production promotion
- CodeQL analysis and dependency review
- Migration hygiene check rejecting duplicate migration numbers
- Scope guard flagging commerce vocabulary in review
- Issue templates for epics, features, tasks and bugs
- Backlog: 8 epics and 36 features across milestones M0–M5

### Fixed
- Preview deploys never worked: `versions upload` ran without `--env preview`, so
  it uploaded the top-level configuration — whose bindings are local placeholders
  — and failed on an invalid KV namespace after provisioning a stray R2 bucket
  (#11)
- Staging and production migrations ran without `--env`, so wrangler resolved the
  database from the top-level configuration and could not find it (#12)
- Coverage reported 0% of 997 statements: the `v8` provider cannot instrument code
  running inside workerd. Under `istanbul` the real figure is 91% of statements,
  now enforced as a threshold that fails the build on a drop (#10)
- Smoke tests could not fail: they requested `/health`, which the SPA fallback
  answers with a 200 for any unmatched path, against a domain that does not
  resolve. They now assert `/api/health` reports the expected environment (#11)
- The scope guard missed `createCheckout` and `orderItems` — the casings commerce
  would actually arrive in (#10)

### Changed
- CI is one `verify` job rather than a four-way matrix: on a single self-hosted
  runner the matrix ran serially and reinstalled dependencies four times, costing
  thirteen minutes. Same checks, 2m10s (#10, #53)
- Actions run on a self-hosted runner; hosted runners remain blocked at the
  account level (#53)
- Actions approval required for all outside contributors — the repository is
  public and the runner is a personal machine (#53)
- `main` is protected: no direct pushes, `verify` required, linear history (#14)
