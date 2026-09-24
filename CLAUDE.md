# Working in this repository

Read `CONTRIBUTING.md` and `docs/WAYS_OF_WORKING.md` first; they are the rules.
What follows is what an agent session has to be told explicitly.

## Branch names

Name every branch for what it does, following CONTRIBUTING.md:

- `feat/<issue-number>-<short-slug>` for a feature, e.g. `feat/28-admin-console`
- `fix/<issue-number>-<short-slug>` for a bug, e.g. `fix/109-hydration-418`
- `chore/<short-slug>` (or `docs/…`, `test/…`, `refactor/…`) for everything else

Leave out the issue number only when there is no issue. Keep the slug to a few
lowercase words joined by hyphens.

**Never use a generated name** like `claude/confident-pascal-u4x37g`. When a
session is handed a branch with a name like that, create a properly named branch
from `origin/main` instead, and do the work and the push there. The repo owner
has given standing permission for this. Say which branch you used when you report
back.

A branch whose pull request is already open keeps its name: renaming it would
orphan the PR.
