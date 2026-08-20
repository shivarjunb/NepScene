# Backlog

53 issues: 8 epics, 43 features, 1 spike and 1 blocking bug — across six milestones.

Every feature carries a plain-language explanation, a scope checklist, acceptance
criteria and a test plan. See [WAYS_OF_WORKING.md](WAYS_OF_WORKING.md) for the model.

## M0 — Foundation
*Anyone can ship safely.*

**[#1] Foundation, environments and the delivery pipeline**
| # | Feature |
|---|---|
| [#53](../../issues/53) | **BLOCKER** — GitHub Actions runs fail at startup · *p0* |
| [#9](../../issues/9) | Application scaffold and workspace structure |
| [#10](../../issues/10) | CI pipeline: typecheck, lint, test, build |
| [#11](../../issues/11) | Cloudflare environments: preview, staging and production |
| [#12](../../issues/12) | D1 migration pipeline |
| [#13](../../issues/13) | Secrets and configuration management |
| [#14](../../issues/14) | Branch protection, review and release process |

**[#2] Design system and the NepScene look and feel**
| # | Feature |
|---|---|
| [#15](../../issues/15) | Extract the design token layer from WaahTickets |
| [#16](../../issues/16) | Core UI primitives |
| [#17](../../issues/17) | Light and dark theming |
| [#18](../../issues/18) | Application shell: navigation, footer and responsive layout |
| [#19](../../issues/19) | NepScene brand identity · *needs design* |

## M1 — Catalogue core
*Listings exist and can be fetched.*

**[#3] Listing catalogue: data model and read API**
| # | Feature |
|---|---|
| [#20](../../issues/20) | Listing data model with type and provenance |
| [#21](../../issues/21) | Venues as first-class entities |
| [#22](../../issues/22) | Organizers, artists and taxonomy |
| [#23](../../issues/23) | Catalog API v1: bounded, paginated, upcoming by default |
| [#24](../../issues/24) | Slugs and canonical URLs |
| [#25](../../issues/25) | Media pipeline on R2 |
| [#26](../../issues/26) | Seed and demo catalogue |

**[#4] Identity, roles and access**
| # | Feature |
|---|---|
| [#27](../../issues/27) | Authentication: email and Google sign-in |
| [#28](../../issues/28) | Roles and permissions |
| [#29](../../issues/29) | Account management · *needs decision* |

## M2 — Event authoring
*Someone can create and publish an event with a location.*

**[#5] Event and venue authoring**
| # | Feature |
|---|---|
| [#30](../../issues/30) | Listing creation wizard |
| [#31](../../issues/31) | Venue picker and map location |
| [#32](../../issues/32) | Map pin appearance and popup customisation |
| [#33](../../issues/33) | Publication workflow and moderation queue |
| [#34](../../issues/34) | Organizer dashboard |
| [#35](../../issues/35) | Decision: recurring and multi-date events · *spike, 3 days* |

## M3 — Map discovery
*The map works against real listings.*

**[#6] Map discovery experience**
| # | Feature |
|---|---|
| [#36](../../issues/36) | Port the map core and finish the Google Maps migration |
| [#37](../../issues/37) | Venue grouping and multi-listing pins |
| [#38](../../issues/38) | Geolocation, distance filtering and the hero map |
| [#39](../../issues/39) | Map performance at catalogue scale |
| [#40](../../issues/40) | Map accessibility and a non-map fallback |

## M4 — Public site
*Publicly usable and findable.*

**[#7] Public discovery site**
| # | Feature |
|---|---|
| [#41](../../issues/41) | Homepage and discovery feed |
| [#42](../../issues/42) | Server-side search and filtering |
| [#43](../../issues/43) | Listing detail pages |
| [#44](../../issues/44) | Venue and organizer pages |
| [#45](../../issues/45) | Server rendering, SEO and structured data |
| [#46](../../issues/46) | Nepali language support |

## M5 — Launch readiness
*Accessible, observed, performant, documented.*

**[#8] Quality, accessibility and operational readiness**
| # | Feature |
|---|---|
| [#47](../../issues/47) | Test strategy and harness |
| [#48](../../issues/48) | End-to-end journey coverage |
| [#49](../../issues/49) | Accessibility compliance to WCAG 2.1 AA |
| [#50](../../issues/50) | Observability and alerting |
| [#51](../../issues/51) | Performance budgets and load testing |
| [#52](../../issues/52) | Launch readiness |

---

## Start here

**[#53](../../issues/53) comes before everything.** Every Actions run on this repo —
including GitHub's own Dependabot workflow — fails at startup with no logs. The
pipelines described in [DEVOPS.md](DEVOPS.md) are configured but never execute, so
nothing is verified on merge until it is fixed. Most likely Actions billing on a
private repo under a free account.

## Critical path

The chain that gates everything else:

```
#9  scaffold
 └─ #11 environments ─┬─ #12 migrations
                      └─ #13 secrets
#15 tokens ─ #16 primitives ─ #18 app shell

#20 listing model ─┬─ #21 venues ─┬─ #23 Catalog API ─┬─ #36 map core
                   └─ #22 taxonomy┘                   ├─ #41 homepage
                                                      └─ #42 search ─ #45 SEO
```

**#20 and #21 are the true bottleneck.** Between them they block eleven downstream
features. If a second person joins, put them here rather than on UI — anything built
against the current single-date, event-scoped schema gets rewritten once listings and
venues become first-class.

## Deliberately deferred

Recorded so they stay decisions rather than oversights:

- **Follows, saves and personal calendars** — the retention layer, post-MVP
- **Editorial collections and curation tooling** — post-MVP
- **Public unauthenticated submission** — foundation is built in #33, opened later
- **Notifications and digests** — post-MVP
- **Ads and sponsored placement** — WaahTickets has a working ad platform to port,
  but its rotation test is failing (audit finding F7); fix before porting
- **Offer API integration** — deferred until there is a hand-off worth making
- **Recurring events** — blocked on the #35 spike

## Setting up the project board

The board is not created yet. The stored GitHub token has `repo` and `workflow`
scopes but not `project`, so it could not be created programmatically:

```bash
gh auth refresh -s project,read:project
gh project create --owner shivarjunb --title "NepScene Delivery"
```

Then bulk-add every issue:

```bash
for n in $(gh issue list --repo shivarjunb/NepScene --limit 100 --json number --jq '.[].number'); do
  gh project item-add <PROJECT_NUMBER> --owner shivarjunb \
    --url https://github.com/shivarjunb/NepScene/issues/$n
done
```

Milestones, labels and issue relationships all work without a board.
