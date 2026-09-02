# Changelog

All notable changes to NepScene are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Repository scaffold: product scope, architecture, extraction plan and ways of working
- DevOps pipeline: CI, per-PR previews, staging on merge, gated production promotion
- CodeQL analysis and dependency review
- Migration hygiene check rejecting duplicate migration numbers
- Scope guard flagging commerce vocabulary in review
- Issue templates for epics, features, tasks and bugs
- Backlog: 8 epics and 36 features across milestones M0–M5
