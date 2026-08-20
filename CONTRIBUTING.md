# Contributing

## Before you start

Read [docs/SCOPE.md](docs/SCOPE.md). The most expensive mistake in this repo is
building something that belongs in WaahTickets.

Then read [docs/WAYS_OF_WORKING.md](docs/WAYS_OF_WORKING.md) for the Epic → Feature →
Task model and the definitions of ready and done.

## Working on a feature

1. Pick a feature issue that meets the definition of ready
2. Branch: `feat/<issue-number>-<short-slug>`
3. Write the tests from the issue's test plan first
4. Build it
5. Open a PR with `Closes #<issue>` — the template will prompt for the rest
6. Verify on the preview deployment, not just locally

## Code conventions

- TypeScript everywhere, `strict` on
- Match the surrounding code's idiom and comment density
- Comments explain constraints the code cannot show — not what the next line does
- No file over ~800 lines. WaahTickets has a 7,011-line route file and a 4,545-line
  component; the cost of that is exactly why this repo exists
- Money is never computed here. Display-only, and always in paisa as an integer

## Commits

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
PRs are squash-merged, so the PR title becomes the commit message — write it for
someone reading `git log` in a year.

## Tests

Every feature ships with the tests from its test plan. A PR that adds behaviour and
no tests will be asked for them.

- **Unit** — pure logic, Vitest
- **Integration** — real HTTP against a seeded local D1
- **End-to-end** — Playwright against a preview deployment
