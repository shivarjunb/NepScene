# Kata Jaam import

Run from the NepScene checkout with Node 22+ and dependencies installed.
The separate WaahTickets importer remains available through `npm run db:import`.

Apply migrations through `0009_katajaam_import.sql` to the target database first.
For staging:

```sh
npx wrangler d1 migrations apply DB --env staging --remote
node scripts/import-katajaam.mjs --env staging --dry-run
node scripts/import-katajaam.mjs --env staging --apply --publish
```

Omitting `--env` targets local D1. Without `--apply`, the importer only writes an
inventory, SQL file, and report under `.katajaam-imports/`. `--apply` imports drafts;
adding `--publish` publishes complete events and leaves uncertain events as drafts.
Events without a valid start date are excluded. End dates are optional.

Use `--input PATH` to reuse an inventory and `--overrides PATH` for reviewed
corrections keyed by the source event URL's final path segment. Existing listings
are preserved. Stable source IDs and fingerprints prevent repeated imports from
creating duplicates. Review the report and the final verification message after
an apply; the printed counts before execution describe the plan, not success.

Run importer tests with `node scripts/tests/katajaam.test.mjs`; CI runs them too.

## Rollback

The migration adds nullable import columns, unique indexes, and an import-source
mapping table. Earlier application versions ignore these additions, so leave the
migration in place when reverting code. Reverting code does not remove imported
listings or change their publication status.
