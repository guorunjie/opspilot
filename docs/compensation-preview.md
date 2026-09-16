# Compensation preview — development boundary

The internal `prepareCompensationPreview` helper does not execute a rollback. It validates an existing Task journal, an explicitly declared compensation capability and a current scoped readback. Conflicting or missing target values yield UNKNOWN and no preview; unsupported capabilities yield UNSUPPORTED. It cannot prove readback freshness or identity authenticity.

The helper creates a new Task and plan, reverses the original target values, and embeds `compensationLink` in PLAN metadata. It does not copy the original approval or execution. Persist each preview history event through the existing `openPersistentTask().checkpoint(next, previous)` interface; do not save an arbitrary task or skip events. Existing replay and atomic revisions preserve this metadata across reopening and reject inconsistent changes. Local journals remain unsigned.

After persistence, the host still must obtain a separate confirmation for the new plan, assign a new execution ID, and revalidate current state and platform/store identity under its existing action-run authorization, idempotency and execution locks. A declared host compensation capability is not permission to invoke it. Production write switches remain off by default.

An interrupted compensation stays UNKNOWN. Do not replay an uncertain operation. Independent per-target readback and complete execution identity are required before reporting a result; a command return, digest or HTTP response is not business verification. This preview and persistence integration does not yet implement host compensation dispatch or establish end-to-end production acceptance.
