# DevOps

## Known blocker: Actions runs fail at startup

**Status as of 2026-08-20: unresolved. This blocks every pipeline below.**

Every workflow run on this repository — including GitHub's own generated Dependabot
workflow — completes immediately with `startup_failure` and produces no logs.

This was isolated rather than assumed. A five-line hello-world workflow on a throwaway
branch failed identically, which rules out the workflow definitions in this repo. All
YAML validates, and every workflow registers as `active`.

The likely cause is GitHub Actions billing on a **private** repository under a **free**
account: private repos draw on a 2,000 minute monthly allowance, and once it is spent —
or if no spending limit is configured — runs fail at startup with exactly this signature.

Two ways to confirm and fix, in order of preference:

1. **Check the Actions allowance** at
   [github.com/settings/billing](https://github.com/settings/billing). If minutes are
   exhausted, either raise the spending limit or wait for the monthly reset.
2. **Make the repository public.** Public repositories get unlimited Actions minutes.
   This is a disclosure decision, not just a billing one — make it deliberately.

Until this is resolved, the pipelines below are configured but never execute, so
nothing is actually being verified on merge.

## Environments

| Environment | Trigger | Data | Purpose |
|---|---|---|---|
| **Local** | `npm run dev` | Local D1 via Miniflare, seeded | Development |
| **Preview** | Every PR | Shared preview D1 | Review with a real URL |
| **Staging** | Merge to `main` | Staging D1, production-shaped | Verification before promotion |
| **Production** | Manual promotion | Production D1 | Live |

Each environment gets its own D1 database, R2 bucket and secrets. WaahTickets runs
local and production against effectively one configuration; NepScene does not repeat
that.

## Pipelines

### `ci.yml` — every push and PR
Typecheck, lint, unit tests, build, migration check. Required to merge. Target under
five minutes; if it creeps past ten, parallelise rather than tolerate it.

### `preview.yml` — pull requests
Deploys to a per-PR Workers preview and comments the URL. Torn down on close.

### `deploy-staging.yml` — merge to `main`
Applies migrations to staging, deploys, runs smoke tests. Auto-rollback on smoke
failure.

### `deploy-production.yml` — manual dispatch
Requires a green staging deploy of the same SHA and an approval. Applies migrations,
deploys, smoke tests, then watches error rate for ten minutes.

### `codeql.yml` and `dependency-review.yml`
Static analysis weekly and on PR; dependency review blocks known-vulnerable
additions.

## Secrets

Held as GitHub Environment secrets, never in the repo. Cloudflare secrets set via
`wrangler secret put`.

| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy workflows |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy workflows |
| `VITE_GOOGLE_MAPS_API_KEY` | Build — restrict by HTTP referrer per environment |

The Google Maps key is referrer-restricted per environment. A single unrestricted key
shared across environments is a billing incident waiting to happen.

## Migrations

Forward-only, sequentially numbered, reviewed like code. Every migration is applied
to staging automatically and to production behind approval.

Rules, informed by WaahTickets carrying duplicate migration numbers (`0009`, `0010`,
`0016`, `0019` each appear twice):

- **Numbers are unique.** CI fails on a duplicate prefix.
- **Additive first.** Add a column, backfill, switch the read, drop later — never in
  one release.
- **Every migration is rehearsed against a production-shaped staging database**
  before promotion.

## Monitoring

Structured logs with a correlation ID per request. Alerts on error rate, p95 latency,
failed deploys and cache unavailability.

Business signals worth watching from day one: listings published per week,
search-to-detail conversion, map interaction rate, and handoff clicks to WaahTickets.

## On-call

Not staffed as a rota at this size. The expectation is that production alerts route
to the person who merged last, and that every deploy is reversible within one
command.
