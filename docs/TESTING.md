# Testing

The rule is one sentence: **testing follows risk.**

The WaahTickets audit found the shape of the alternative precisely — 100 unit
tests across 17 files, and not one of them touching the order lifecycle, which
is exactly where all three critical defects lived. Coverage that avoids the
risky part is theatre. It is worse than no coverage, because it produces a
number that says the opposite of the truth.

For NepScene the risky parts are:

| Risk | Why | Where |
|---|---|---|
| The catalogue read path | Every public page is built from it | `api/catalog/` |
| The authoring write path | The only place untrusted input becomes a row | `api/author/` |
| Permission enforcement | The only place an authorisation decision is made | `api/identity/` |
| The map at scale | Where the architecture would fail first | `app/map/` |
| Server rendering | A failure here is invisible to anyone who has the JS | `api/render/` |

Coverage thresholds in `vitest.config.ts` are set per directory to match, and
each one is the measured floor rounded down — so they fail on a *regression*
rather than aspiring at something nobody meets.

---

## The three levels, and what belongs at each

### Unit — `tests/unit/*.test.ts`

Runs in workerd. **No DOM, no network, no database.**

This is where rules live: ranking, grouping, viewport arithmetic, city
resolution, slug generation, validation. If a thing is a pure function of its
inputs, it is tested here and nowhere else — a rule tested through HTTP is a
rule whose failure message names the wrong thing.

The test to write is the one that would have caught the bug you are worried
about, stated as a claim about behaviour. `rankOf` returns 0 for a live
listing is a claim. `rankOf is called` is not.

### Integration — `tests/integration/*.test.ts`

Runs in workerd against **a real Worker and a real local D1**, over real HTTP
via `SELF.fetch`. Nothing is mocked. The migrations applied are the migrations
production gets.

This is where contracts live: status codes, response shapes, pagination,
permission denials, cache headers, D1 round-trip budgets. The audit's three
critical defects were all things only a request-to-database test would catch,
which is why this level exists at all rather than being replaced by mocks.

### End-to-end — `tests/e2e/*.spec.ts`

Runs in Chromium via Playwright, against two servers (`playwright.config.ts`):

- **`vite preview` on :4173** — the built SPA and no Worker. The catalogue is
  stubbed at the network boundary, which is right when the subject is the
  client: it is the only way to drive an empty catalogue, a failed fetch, or a
  blocked Maps API on demand.
- **`wrangler dev` on :8788** — the real Worker against the seeded local D1.
  `rendering.spec.ts` needs this, because the preview server renders nothing
  and a server-rendering test there would pass while proving nothing.

This is where wiring lives: that a click reaches a handler, that a handler
reaches the router, that focus goes where it should, that nothing scrolls
sideways at 320px.

---

## Writing an integration test

Under ten lines, including the imports:

```ts
import { SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

beforeAll(seedCatalogue)

it('returns upcoming listings by default', async () => {
  const response = await SELF.fetch('https://nepscene.test/api/catalog/listings')
  expect(response.status).toBe(200)
})
```

`seedCatalogue` truncates and reseeds, so it is idempotent and safe to call in
`beforeAll`, in `beforeEach`, or twice in a row.

---

## Fixtures and factories

### `tests/factories.ts` — for shapes

Use `aListing`, `aPlacedListing`, `aVenue`, `anOrganizer`, `aCategoryRef`,
`anOffer`. Nine files used to carry their own hand-rolled `Listing` literal,
and adding one field to the contract meant editing all nine — with any that
were missed compiling fine, because `Partial` swallowed them.

The maintenance cost is the smaller problem. **A fixture written by hand is
written to suit the test it sits in.** If `is_featured` is whatever that file
happened to need, a test asserting "featured sorts first" against a bank where
everything is featured passes while proving nothing.

So every factory default is the least interesting valid value — not featured,
no offer, no categories, no coordinates, one fixed instant — and anything a
test cares about it has to override. That override is then the visible
statement of what the test is about:

```ts
const listings = [aListing({ id: 'a' }), aListing({ id: 'b', is_featured: true })]
```

A reader can see from that line which one is supposed to win.

### `tests/helpers/seed.ts` — for rows in D1

A small, fully deterministic catalogue: four upcoming listings, two venues 140km
apart, one past, one draft, one pending review. It exists so a test can say
"exactly four listings are upcoming" and mean it. `scripts/seed-demo-catalogue.sql`
is the bigger one, for developing against — never for assertions.

### `tests/e2e/mapStub.ts` — for the browser

A `google.maps` that draws nothing but holds a viewport, plus route handlers for
the catalogue, geolocation and `/here`. The SDK owns pans and marker clicks, so
there is no DOM to drive them from — `__panTo`, `__clickMarker`, `__flurry` and
`__markerCount` are the seam.

---

## Isolation: what is actually guaranteed

**Writes are not rolled back.** The guarantee is that `seedCatalogue` truncates
*before* it seeds, so whatever a previous file left behind is gone before this
one looks. A file that writes and never re-seeds does leak into the next file
that also does not seed. Seed in `beforeAll`. `tests/integration/isolation.test.ts`
is the test that keeps this honest.

**D1 is not the only shared state.** Catalog reads are cached in the colo, keyed
on a version counter that only `bumpCatalogVersion` moves. A test that writes
straight to `env.DB` and re-reads the same URL gets the *previous test's*
response, for up to a minute, with no error anywhere:

```ts
await env.DB.prepare('INSERT INTO listings …').run()
await bumpCatalogVersion(env)   // ← without this you read a stale response
```

Writing through the API bumps it the way publishing does. Writing behind the API
has to do it itself.

---

## Measuring performance in a test

Two rules, both learned the hard way and both visible in
`tests/integration/searchScale.test.ts` and `mapScale.test.ts`.

**Assert ratios, not milliseconds.** Vitest runs fifty-odd files at once, so
wall-clock largely measures what else the machine is doing — the same search
takes 60ms alone and 270ms under a full suite. A number tuned on a quiet laptop
fails on a loaded CI runner, and a test that flakes gets deleted rather than
fixed. Compare the query against *itself* under a different filter, so both
absorb the same background load and what is left is the shape of the query.

**Say what you cannot measure.** Frame rate on a mid-range Android over
throttled 3G is the criterion that matters most for the map, and nothing in a
headless Chromium on a developer's laptop can honestly claim to have measured
it. It stays a manual line in the test plan. `scripts/check-budget.mjs` measures
what CI *can* — bytes over the wire — and prints the gap to the real target
rather than redefining the target as met.

---

## Running things

```bash
npm test                  # unit + integration, in workerd
npm run test:coverage     # the same, with per-directory thresholds enforced
npm run test:e2e          # Playwright; builds first, because the shell is a fixture
npm run budget            # the bundle ratchet, after a build
npm run typecheck         # four tsconfigs: worker, app, node, e2e
```

A single file: `npx vitest run tests/unit/ranking.test.ts`, or
`npx playwright test tests/e2e/map.spec.ts`.

CI runs all of it plus the guards (`npm run ci:guards`) — migration numbering,
the commerce scope guard, and a committed-credential check that covers what
GitHub push protection does not.

---

## What not to test

- **That a mock was called.** It proves the test wrote the mock correctly.
- **Framework behaviour.** React rendering a prop is React's test, not ours.
- **Through HTTP what a pure function settles.** The failure message names the
  endpoint instead of the rule, and the next person debugs the wrong file.
- **Snapshots of anything with a date in it.** They pass until they do not, and
  then they are updated without being read.
