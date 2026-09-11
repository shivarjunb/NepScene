# Incident runbook

The rule this whole document serves: **nothing is caught silently.** Every
error NepScene swallows on purpose writes a structured line first, and a
`scripts/check-silent-catches.mjs` failure is what stops that decaying into a
convention nobody follows (#50).

The motivating case is F2 in the WaahTickets audit: paid orders producing no
tickets, because the failure was swallowed into a response header nobody read.
It was invisible for as long as it existed. An error that is caught and not
reported is worse than one that crashes — it removes the signal without
removing the problem.

---

## Finding anything at all

Every response carries `x-request-id`. It is Cloudflare's `cf-ray` when there
is one, so it joins up with Cloudflare's own logs rather than being an id only
we know about.

**Ask the reporter for it.** One string finds every line that request produced:

```bash
npx wrangler tail --env production --format json \
  | jq 'select(.logs[]?.message[0] | fromjson? | .request_id == "<id>")'
```

Live tailing only catches what happens while you watch. For anything already
over, the same lines are in Workers Logs in the dashboard, filtered on
`channel = "nepscene"`.

### The log shape

One JSON object per line. `channel` is always `nepscene`, which is how you
separate ours from the runtime's:

| Field | Meaning |
|---|---|
| `event` | `request_failed`, `swallowed`, `render_failed` |
| `request_id` | The correlation id. Present on every line inside a request. |
| `level` | `warn` for a client's fault, `error` for ours |
| `reason` | On `swallowed` only. Low-cardinality — group by this. |
| `cause` | The caught error's message |

`reason` is deliberately a fixed slug with no id, slug or URL in it, so a
dashboard can count `swallowed by reason` and get a small, stable set.

---

## The three most likely failures

### 1. The catalogue is slow, or timing out

**What you will see.** `request_failed` at `status: 500` on `/api/catalog/*`,
or p95 latency climbing with no error rate change.

**First check the round-trip budget.** Every catalog response carries
`x-d1-round-trips`, and the budget is 1–3 (`docs/ARCHITECTURE.md`, rule 4):

```bash
curl -sI 'https://<host>/api/catalog/listings?limit=20' | grep -i x-d1-round-trips
```

Above 3 means a query started fanning out per row. That is the failure mode
that passes every correctness test and is unusable from Kathmandu — WaahTickets
ran eight DDL statements in one middleware, which was ~1.6s of its ~2s response
time.

**Then check whether the cache is working.** `/api/cache/status` reports the
version counter. If `swallowed` lines with `reason: catalog_version_read` are
appearing, KV is unreachable and every read is falling through to D1 — the site
works and is much slower, which is exactly the degrade that hides itself.

**Rollback** if a deploy caused it: `docs/DEVOPS.md` → Rollback. It is the
fastest fix and it is reversible.

### 2. Sign-in is failing, or unthrottled

**What you will see.** `request_failed` with `code: oauth_failed` or
`invalid_credentials` at a rate; or `swallowed` with
`reason: rate_limit_kv_read`.

**The rate-limit one is the dangerous one and it is silent by design.** KV
unavailable means `checkRateLimit` fails *open* — because failing closed locks
everyone out of sign-in, which is worse for a minute. Over an hour it means
sign-in is unthrottled and a credential-stuffing run has no brake. A sustained
rate of that reason is an incident, not a blip.

If sign-in itself 500s after a deploy, suspect the PBKDF2 iteration count:
Workers refuses above 100,000 with `NotSupportedError`, Node does not, so a
hash written by a script with a higher count verifies locally and fails in
production (`scripts/create-admin.mjs` has the long version).

### 3. Public pages render as the empty shell

**What you will see.** `event: render_failed` at `level: error`. Readers see
nothing wrong — the SPA boots, fetches and paints. **Crawlers get an empty
document**, and so does anyone whose bundle never arrives.

This is deliberate: turning a transient D1 problem into a blank 500 on every
public page is the worse trade. It also means the failure is invisible from the
outside, which is exactly why it is logged at `error` rather than swallowed.

**Check** that the SSR bundle is present — `render_failed` on *every* path
usually means `dist/ssr/server.js` is missing or stale rather than anything
being wrong with a page. Then check one page directly with JavaScript off:

```bash
curl -s 'https://<host>/listings/<slug>' | grep -c '<h1'
```

Zero means the render path is down. A number means the page is fine and the
errors are for something more specific.

---

## What is not wired up yet

Honest gaps, so nobody goes looking for a dashboard that does not exist:

- **No alerting.** The counters exist and are queryable; nothing pages anybody
  yet. Alert destinations need a Cloudflare account decision — see
  `docs/BACKLOG.md` → Waiting on you.
- **No dashboards.** Same reason. The log shape above is stable and designed to
  be grouped by, so building them is configuration rather than code.
- **No Maps quota alert.** A Google Cloud console task (#13, #36).

Until those land, the runbook above is the mechanism, and it starts with
someone noticing.
