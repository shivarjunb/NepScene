# Ways of working

## The hierarchy

**Epic → Feature → Task.** Three levels, each with a different job.

### Epic
A body of work with a coherent outcome, usually spanning milestones. An epic
explains *why* and holds features together. It is never worked on directly.

Labelled `type:epic`. Titled `[EPIC] …`.

### Feature
**The unit of work.** A feature is something a person could notice shipping. It
carries the acceptance criteria and the test plan, and it is what gets assigned,
estimated and closed.

Labelled `type:feature`. Titled `[FEAT] …`.

A feature is too big if it cannot ship in about a week. Split it.

### Task
A checklist item **inside** a feature issue, not a separate issue. Tasks are how the
person doing the work breaks it down; they are not planning artefacts and nobody
tracks them across sprints.

Tasks only graduate to their own issue when they need separate assignment.

## Feature anatomy

Every feature issue has five sections, in this order:

1. **What and why** — plain language. Someone outside the team should understand
   what changes and why it matters. Not a restatement of the title.
2. **Scope** — a task checklist. What is included, and explicitly what is not.
3. **Acceptance criteria** — observable, checkable statements. "Search returns
   results ranked by date proximity" is testable; "search works well" is not.
4. **Test plan** — the specific tests to write, by level (unit, integration, E2E,
   manual). Written *before* the work starts.
5. **Dependencies** — what must land first.

## Definition of ready

A feature can be picked up when it has acceptance criteria, a test plan, a
milestone, an area label, and no unresolved blocking dependency.

## Definition of done

- Acceptance criteria all demonstrably met
- Tests from the test plan written and passing in CI
- No drop in coverage on changed files
- Works at 320px and on a mid-range Android device
- Meets WCAG 2.1 AA for anything user-facing
- Documentation updated when behaviour or setup changed
- Reviewed and approved
- Deployed to staging and verified there

## Labels

| Prefix | Purpose |
|---|---|
| `type:` | epic, feature, task, bug, chore, spike |
| `area:` | catalog, map, design-system, author, api, identity, devops, quality, seo, discovery |
| `priority:` | p0 (blocker), p1 (must), p2 (should), p3 (could) |
| `status:` | blocked, needs-design, needs-decision |

## Milestones

| Milestone | Outcome |
|---|---|
| **M0 — Foundation** | Repo, pipeline, environments. Anyone can ship safely. |
| **M1 — Catalogue core** | Data model and read API. Listings exist and can be fetched. |
| **M2 — Event authoring** | Someone can create and publish an event with a location. |
| **M3 — Map discovery** | The map works against real listings. |
| **M4 — Public site** | Browse, search, detail pages, SEO. Publicly usable. |
| **M5 — Launch readiness** | Accessible, observed, performant, documented. |

Milestones gate on outcome, not date. M2 is not done because the sprint ended; it is
done when someone can create and publish an event.

## Branching and releases

- `main` is always deployable and protected
- Work on `feat/<issue>-<slug>`, `fix/…`, `chore/…`
- Squash merge, PR title becomes the commit, `Closes #123` in the body
- Every PR gets a preview deployment
- `main` deploys to staging automatically; production is a manual promotion
