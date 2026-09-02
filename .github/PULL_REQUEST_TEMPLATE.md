## What this changes

<!-- Plain language. What is different after this merges? -->

Closes #

## How it was verified

<!-- What did you actually run? Not "should work" — what you observed. -->

- [ ] Tests from the feature's test plan are written and passing
- [ ] Verified locally
- [ ] Verified on the preview deployment

## Checklist

- [ ] Acceptance criteria on the linked issue are met
- [ ] No coverage drop on changed files
- [ ] Works at 320px width
- [ ] Keyboard accessible, meets WCAG 2.1 AA where user-facing
- [ ] Docs updated if behaviour or setup changed
- [ ] Migrations are additive and uniquely numbered
- [ ] No commerce concern introduced (see docs/SCOPE.md)

## Rollback

<!--
Required when this PR adds a migration (#12). What does the previous release do
against the new schema, and what has to happen if this deploy is reverted?
Additive-first is what makes the answer usually "nothing — the previous build
ignores the new column". Delete this section if there is no migration.
-->

## Screenshots

<!-- For anything visual, light and dark. -->
