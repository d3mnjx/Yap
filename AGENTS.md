# Repository guidance

## Reference documents

- Read `docs/offline-client-architecture.md` before changing client ownership or recovery logic.
- Use `docs/offline-behavior.md` for the offline contract and `docs/feature-parity-inventory.md` for feature behavior and verification limits. Keep feature IDs stable and update affected rows when behavior changes.
- Follow `tests/browser/README.md` for checks and formatting, and `GHCR-DEPLOYMENT-GUIDE.md` for deployment and rollback.

## Coding principles

- Prefer straightforward solutions, focused components and explicit ownership. Avoid abstractions for hypothetical requirements.
- Write for the next maintainer. Comments explain the constraint, bug or trade-off behind a choice, especially at invariants that an innocent cleanup could break.
- Preserve the existing UI and interactions except for documented changes. Pending messages use normal grouping and faded appearance; do not add queued/sent/draft-save labels. Keep actionable failure feedback and Retry.
- Keep account isolation, authorization, atomic receipt acceptance and retry deduplication. A retry must not repeat a mutation; an edit must not resurrect a deleted message.
- Competing edits use the last server-accepted edit. Do not introduce merge dialogs, automatic text merging or a distributed conflict framework.
- Keep account/connection coordination explicit. Capture owners before asynchronous work and preserve generation checks, draft restoration, history invalidation and media DOM lifetime rules.

## Validation

- Use isolated synthetic data for browser and server checks. Keep credentials and runtime data outside source/evidence.
- Run relevant checks for a change and record remaining limitations honestly. Source inspection, screenshots and browser API fixtures do not establish full device/provider parity.
- Keep vendor attribution/licenses intact. The startup shell manifest hashes the deployed assets; publish the complete package, including compressed variants, and verify worker installation; preserve deployed browser namespaces and persisted receipt compatibility.
- Preserve unrelated working-tree changes. Commit focused changes with relevant validation; push only when requested.
