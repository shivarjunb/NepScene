# DevOps

## The runner

Actions runs on this repository are executed by a **self-hosted runner**, not by
GitHub-hosted ones (#53).

Hosted runners could not be allocated for any repository on this account, on either
visibility: private repos failed with `startup_failure` in 0s, and a public repo got
as far as creating a job that died in ~2s with `steps: []` and no runner name. Public
repositories get unlimited free minutes, so a minutes shortfall does not explain it —
the block is account-level and lives at
[github.com/settings/billing](https://github.com/settings/billing).

Rather than wait on that, the pipeline runs on a macOS runner registered to this
repository:

| | |
|---|---|
| Location | `~/actions-runner-nepscene` |
| Runs as | a launchd service (`./svc.sh status`) |
| Labels | `self-hosted` |
| Concurrency | **one job at a time** |

What follows from that, and is not optional to remember:

- **CI is one job, not a matrix.** A four-way matrix runs serially here and pays for
  `npm ci` four times — thirteen minutes against the five-minute target. One job
  sharing one install comes in around three.
- **The runner is a real machine that must be awake.** A queued run that never starts
  usually means the laptop is asleep, not that Actions is broken again.
- **The repository is public, so workflow approval is not optional.** Actions is set
  to require approval for all outside contributors. Without it, anyone's fork PR would
  execute their code on this machine.

If hosted runners are ever restored, changing `runs-on: self-hosted` back to
`ubuntu-latest` is the whole migration — and the matrix can come back with it.

### When runs sit in `queued` and nothing starts

Seen in practice: the runner's long-poll connection to GitHub drops, and the
listener retries with backoff without ever recovering. The API still reports the
runner `online` and `busy: false`, and the Actions tab still says `queued`, so
nothing about the symptom points at the runner.

Confirm from the tail of the newest `_diag/Runner_*.log`:

```
[... ERR  BrokerServer] System.Net.Sockets.SocketException (89): Operation canceled
[... WARN BrokerServer] Back off 10.994 seconds before next retry. 4 attempt left.
```

Then bounce it:

```bash
cd ~/actions-runner-nepscene && ./svc.sh stop && ./svc.sh start
```

Queued jobs are picked up within seconds. Nothing is lost — they were never started.

### Contention

One runner takes one job at a time, and a PR fires four workflows: CI, preview
deploy, CodeQL and dependency review. They queue behind each other, so wall-clock
from push to all-green is roughly the sum, not the longest. CI itself is what the
five-minute target in #10 measures; if the wait to *start* becomes the thing that
hurts, register a second runner rather than trimming the checks.

Dependabot is what makes this bite. Its first run after the scaffold landed opened
**four** action-bump PRs, each firing four workflows — fifteen queued jobs behind
which everything else waited about forty minutes. Three changes keep that from
recurring:

- `dependabot.yml` groups **all** github-actions bumps into one PR
- `preview.yml` skips Dependabot PRs — a dependency bump has nothing to preview
- `codeql.yml` skips them too; the weekly schedule and the push to `main` cover
  the source, which a bump does not change

Dependabot PRs still run `verify` and dependency review, which is the point of
testing a bump. Two jobs instead of sixteen.

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

### Provisioned resources

Cloudflare account `7450b428a50935bc2d97b4f5e7fd5835` (bhattarai.shiva@gmail.com).
The account also holds the WaahTickets worker; there is a **second** Cloudflare
account on this login, so `wrangler whoami` before anything that writes.

| Environment | Worker | D1 | KV | R2 |
|---|---|---|---|---|
| preview | `nepscene-preview` | `nepscene-preview` | `settings-preview` | `nepscene-media-preview` |
| staging | `nepscene-staging` | `nepscene-staging` | `settings-staging` | `nepscene-media-staging` |
| production | `nepscene` | `nepscene-production` | `settings-production` | `nepscene-media-production` |

- Staging: https://nepscene-staging.bhattarai-shiva.workers.dev
- Production: https://nepscene.bhattarai-shiva.workers.dev

All three databases have **read replication set to `auto`**, which is what makes
`withSession('first-unconstrained')` in `api/lib/d1.ts` serve reads from a nearby
replica. It is set through the API, not `wrangler.jsonc` — if a database is ever
recreated, set it again or reads silently go back to the primary.

Preview and staging carry the demo catalogue. **Production carries the schema and
the twelve reference categories only.** The demo listings are invented events;
seeding them into a live discovery site would publish fiction.

Commands, per environment:

```bash
npx wrangler d1 migrations apply DB --env staging --remote
npx wrangler d1 execute DB --env staging --remote --file=./scripts/seed-demo-catalogue.sql
npx wrangler deploy --env staging
```

## Pipelines

### `ci.yml` — every push and PR
One `verify` job: migration hygiene, scope guard, typecheck, lint, tests with
coverage, build. Required to merge. Runs in about three minutes; if it creeps past
five, cut work out of it or add a second runner — do not tolerate it.

Type and lint errors are placed on the diff as annotations by `scripts/annotate.mjs`,
and coverage is posted as a PR comment and written to the job summary.

**Coverage is a ratchet.** Thresholds in `vitest.config.ts` sit at the measured floor,
so a drop fails the build. When coverage rises, raise them with it in the same PR.
The provider is `istanbul` deliberately: `v8` cannot instrument code running inside
workerd and silently reports 0% for every file the integration tests exercise.

### `preview.yml` — pull requests
Uploads a Worker **version** against the preview environment (`--env preview`) and
comments the version preview URL on the PR. It is a version upload, not a deployment,
so no preview traffic is taken and there is nothing to tear down on close; the version
simply stops being referenced.

`--env preview` is load-bearing. Without it wrangler uploads the top-level config,
whose bindings are local placeholders, and the deploy fails on an invalid KV namespace
after provisioning a junk R2 bucket in the real account.

### `deploy-staging.yml` — merge to `main`
Applies migrations to staging, deploys, then runs `scripts/smoke.mjs`. A failed smoke
test fails the run; rollback is the one command below, not automatic.

### `deploy-production.yml` — manual dispatch
Two jobs, in this order and for a reason:

1. **`gate`** — no `environment:`, so it runs immediately. It reads
   `deploy-staging.yml`'s run history for the dispatched SHA and fails unless one
   of those runs concluded `success`.
2. **`promote`** — `needs: gate`, declares `environment: production`. Applies
   migrations, deploys, smoke tests.

The split matters. A job that declares an environment is held at the approval gate
*before any of its steps run*, so while the check lived inside `promote` it could
only reject an unverified SHA after a reviewer had already approved promoting it —
the guard was real but fired too late to be useful. Now the refusal costs nobody a
click.

To see the gate refuse, dispatch a SHA that failed on staging:

```
gh workflow run deploy-production.yml \
  -f sha=<a SHA whose staging deploy failed> \
  -f reason="Negative test"
```

The `gate` job logs which staging runs it found for that SHA whether it passes or
fails — a gate you can only observe when it refuses is indistinguishable from one
that is broken open.

### Rollback

One command, from a clean checkout:

```
npx wrangler rollback --env production        # or --env staging
npx wrangler deployments list --env production  # confirm what is live
```

`rollback` moves traffic back to the previous deployment. It does **not** undo a
migration — that is why migrations are additive-first (below): the previous build has
to keep working against the new schema.

### `codeql.yml` and `dependency-review.yml`
Static analysis weekly and on PR; dependency review blocks known-vulnerable
additions.

## Secrets

Held as GitHub Environment secrets, never in the repo. Cloudflare secrets are set with
`wrangler secret put --env <environment>`.

| Secret | Where it lives | Used by |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub Environment secret | Deploy workflows |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Environment secret | Deploy workflows |
| `VITE_GOOGLE_MAPS_API_KEY` | GitHub Environment secret | Build — referrer-restricted per environment |
| `GOOGLE_CLIENT_SECRET` | Cloudflare secret binding | Worker, per environment |

`GOOGLE_CLIENT_ID` is a plain var in `wrangler.jsonc` (it is public by design).
Leaving both empty disables Google sign-in rather than breaking it, so a preview
environment without credentials still runs. `.dev.vars.example` documents everything a
developer needs locally; nothing in it is a shared credential.

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set as **Environment** secrets
on all three environments, not as repository secrets. That is deliberate: a repository
secret is readable by any workflow, including one added in a pull request, and the
production token would then be one merge away from anywhere. An Environment secret is
only visible to a job that declares that `environment:` — which is why `ci.yml` cannot
see them, and should not.

### What push protection does and does not catch

Secret scanning and push protection are both on, and they work — pushing a Slack token
and a Stripe key to a branch was refused outright.

They are not complete. A **Google API key** (`AIza…`, 35 characters) pushed to this
repository **cleanly**, and that is the shape of the Maps key: the one credential here
that is a build-time public value and the one most likely to be pasted somewhere for a
moment. Do not rely on push protection to catch it.

`npm run ci:guards` therefore runs `scripts/check-secrets.mjs`, which fails the build
on a committed credential — by shape for the Google formats, and by name
(`CLOUDFLARE_API_TOKEN=<40 characters>`) for the ones no regex can recognise on sight.
It reads `git ls-files`, so an untracked, gitignored `.dev.vars` is correctly ignored.
Prove it still works by committing a fake key and running it; it names the file and
line.

If a credential does reach a commit, **rotate it first**. Removing the line does not
un-leak it — the value is in the reflog, in any fork, and in whatever scraped the push.

### Google Maps keys

**Read since #31; still to be provisioned.** The wizard's venue picker and the public
map (`/map`) both load the Maps JavaScript API with `VITE_GOOGLE_MAPS_API_KEY`
(`app/lib/googleMaps.ts`), and the four build workflows already pass it through. No key
exists yet, and that is survivable rather than broken on both surfaces: the picker
falls back to typed coordinates, and the map renders a notice pointing at the listings
feed instead of a blank rectangle. Preview deployments and the Playwright server
therefore work with no key at all.

What a missing key costs is the map itself, so provisioning is the last open item on
#36. Everything below is a Google Cloud console task — the workflows need no change.

One key per environment, each restricted by HTTP referrer, each with a quota alert.
The key is a build-time public value baked into the bundle — an unrestricted key
shared across environments is a billing incident waiting to happen, and NepScene will
call the Maps API far more than WaahTickets does.

| Environment | Referrers |
|---|---|
| local | `http://localhost:5173/*`, `http://localhost:8787/*` |
| preview | `https://*.workers.dev/*` |
| staging | the staging origin only |
| production | the production origin only |

Set a quota alert on each key at a threshold below the free tier, so the alert arrives
before the bill does.

### Rotating a secret

Under fifteen minutes, in this order. The overlap matters: create the new credential
before revoking the old one, or the environment is down for the length of the rotation.

1. **Create** the replacement (Cloudflare API token, Google client secret, Maps key)
   alongside the existing one. Do not revoke anything yet.
2. **Set** it where it is consumed:
   - GitHub: `gh secret set NAME --env <environment> --repo shivarjunb/NepScene`
   - Cloudflare: `npx wrangler secret put NAME --env <environment>`
3. **Redeploy** the environment so the new value is in effect — staging by re-running
   the staging workflow, production by promoting the same SHA again.
4. **Verify** with `node scripts/smoke.mjs <base-url> <environment>`.
5. **Revoke** the old credential at its source, and only then.
6. **Record** the rotation date in the PR or the incident notes.

## Migrations

Forward-only, sequentially numbered, reviewed like code. Every migration is applied
to staging automatically and to production behind approval.

Rules, informed by WaahTickets carrying duplicate migration numbers (`0009`, `0010`,
`0016`, `0019` each appear twice):

- **Numbers are unique.** CI fails on a duplicate prefix.
- **Additive first.** Add a column, backfill, switch the read, drop later — never in
  one release.
- **Numbering is gapless.** `wrangler d1 migrations apply` tracks a high-water mark;
  a migration numbered below one already applied is skipped in silence. CI fails on a
  gap for that reason, not for tidiness.
- **Every migration is rehearsed against a production-shaped staging database**
  before promotion.

### Rehearsing a migration

Staging is the rehearsal. The point is to apply the migration to data shaped like
production's — not to an empty database, where every migration passes.

```bash
# 1. Refresh staging from a production export, so the rehearsal is honest.
npx wrangler d1 export nepscene-production --remote --output /tmp/prod.sql
npx wrangler d1 execute nepscene-staging --remote --file=/tmp/prod.sql

# 2. Apply, and watch it against real row counts.
npx wrangler d1 migrations apply nepscene-staging --remote

# 3. Prove the data survived.
npm run db:verify -- --env staging
node scripts/smoke.mjs https://nepscene-staging.bhattarai-shiva.workers.dev staging
```

Until production carries data worth exporting, seed staging with
`npm run db:volume` instead — 10,000 listings exercises pagination and index
choice in a way a hand-written fixture does not.

Every PR that adds a migration states its rollback in the description: what the
previous release does against the new schema, and what has to happen if the deploy is
reverted. Additive-first is what makes that answer usually "nothing".

## Monitoring

Structured logs with a correlation ID per request. Alerts on error rate, p95 latency,
failed deploys and cache unavailability.

Business signals worth watching from day one: listings published per week,
search-to-detail conversion, map interaction rate, and handoff clicks to WaahTickets.

## On-call

Not staffed as a rota at this size. The expectation is that production alerts route
to the person who merged last, and that every deploy is reversible within one
command.
