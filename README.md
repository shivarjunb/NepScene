# NepScene

**What's happening around Nepal.**

NepScene is an event *discovery* product. It answers one question well: what is on,
near me, soon — concerts, festivals, sports, comedy, food, nightlife, community
events and everything in between.

It is deliberately **not** a ticketing system. NepScene lists events it cannot sell,
which is the whole point: most of what happens in Nepal is free, community-run, or
ticketed somewhere else. A shop window that only shows its own stock is not a
discovery product.

Commerce lives in a separate product, [WaahTickets](https://github.com/shivarjunb/WaahTickets).
When a NepScene listing is purchasable, NepScene hands the visitor off. It never
takes money itself.

---

## Scope

### In scope

| Area | What we build |
|---|---|
| **Listings catalogue** | Ticketed, free, external and community events as equal citizens |
| **Event authoring** | An organizer or editor can create and publish an event with a location |
| **Map discovery** | The interactive Nepal map — category pins, venue grouping, distance |
| **Browse & search** | Server-side search, filters, category and city browsing |
| **Detail pages** | Addressable pages for events, venues and organizers |
| **Look and feel** | The design system, theming and app shell carried over from WaahTickets |
| **Identity** | Accounts and roles, enough to author and moderate listings |

### Explicitly out of scope

Carts, checkout, payments, orders, tickets, QR codes, scanning, coupons,
commissions, referrals, refunds, payouts and settlement. All of it belongs to
WaahTickets. If a work item in this repo starts growing a price field that the
server has to trust, it is in the wrong repo.

The one seam: a listing may carry an **offer** — a price-from and a link to
somewhere a visitor can buy. NepScene renders that offer. It never computes it.

---

## Relationship to WaahTickets

NepScene is being extracted from the existing WaahTickets codebase rather than
written from nothing. The parts worth carrying over are already good:

- the Google Maps discovery surface, venue grouping and pin system
- the event creation wizard, minus its ticket-type and coupon steps
- the design system, dark mode and responsive app shell
- the Cloudflare Workers + Hono + D1 backend shape

See [docs/EXTRACTION.md](docs/EXTRACTION.md) for what is ported, what is rewritten,
and what is left behind.

---

## Stack

Deliberately the same as WaahTickets, so extraction is a port rather than a rewrite.

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| API | Hono |
| Database | Cloudflare D1 (SQLite) |
| Object storage | Cloudflare R2 |
| Frontend | React 19 + Vite + TypeScript |
| Maps | Google Maps JavaScript API |
| Styling | Plain CSS with a shared token layer |
| Tests | Vitest, plus Playwright for end-to-end |

---

## Getting started

```bash
git clone https://github.com/shivarjunb/NepScene.git
cd NepScene
npm install

npm run db:migrate     # apply migrations to the local D1
npm run db:seed        # load the demo catalogue
npm run build          # build the SPA the Worker serves
npm run dev            # http://localhost:8787
```

Then:

```bash
curl 'http://localhost:8787/api/catalog/listings?limit=5'
curl 'http://localhost:8787/api/catalog/search?q=thamel'
curl 'http://localhost:8787/api/cache/status'
```

`npm run db:reset` drops the local database and rebuilds it from migrations plus
the demo seed. `npm test` runs the unit tests and the integration tests, which
go over real HTTP against a real local D1.

### What exists today

The catalogue and its read API (**M1**). The design system, the map and the
public site are still ahead — see [docs/BACKLOG.md](docs/BACKLOG.md).

---

## Documentation

| Document | What it covers |
|---|---|
| [docs/SCOPE.md](docs/SCOPE.md) | In scope, out of scope, and why the line falls there |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System shape, data model, API contracts |
| [docs/EXTRACTION.md](docs/EXTRACTION.md) | What comes across from WaahTickets, file by file |
| [docs/DEVOPS.md](docs/DEVOPS.md) | Environments, pipelines, releases, on-call |
| [docs/WAYS_OF_WORKING.md](docs/WAYS_OF_WORKING.md) | Epic/Feature/Task model, definition of done |
| [docs/BACKLOG.md](docs/BACKLOG.md) | The full backlog, critical path and deferred decisions |

## Planning

Work is tracked as **Epics** (why), **Features** (what ships) and **Tasks**
(checklist items inside a feature). Every feature carries acceptance criteria and a
test plan before it is picked up.

Milestones run M0 through M5. The full backlog — 8 epics, 43 features and 1 spike —
is indexed in [docs/BACKLOG.md](docs/BACKLOG.md).
