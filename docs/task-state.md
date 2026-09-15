# Persistent Task vertical slice

New offline sessions now use `src/task/taskState.js`, not only a display status
translation. Commands advance a Task before execution or verification; desktop
execution/readback controls use that Task. Each user command saves the task,
plan, approval, run, verification results, event history and mock target map in
the same existing optimistic-revision SQLite snapshot. Restoring a Task replays
events and compares the computed state to the saved record. Demo validation
also binds it to the session, preview, submission count and review.

## Rules

- A check precedes a plan. Missing data is a distinct state.
- Explicit confirmation binds the current plan; confirmed plans cannot change.
  Plan identifiers cannot be reused even before approval.
- A task has one execution run. SUBMITTED is never VERIFIED. Lost submission
  response or interrupted execution becomes UNKNOWN; another START is rejected.
- Verification requires a readback event after BEGIN_VERIFY and independently
  compares scoped target values. Partial matches remain PARTIALLY_VERIFIED;
  missing observations remain unknown. Read-only verification may be retried.
- ROLLED_BACK requires exact original-value readback plus explicit rollback
  confirmation. This is a result-checking contract, **not a rollback executor**.
  Once rollback reconciliation has begun, forward verification is blocked;
  an unknown rollback must continue checking the original target values.

The twelve task states are implemented by explicit events; no generic command
lets a caller assign VERIFIED. The state reducer itself does no I/O. Caller
code owns trusted checks, actual user-approval capture, connector retrieval,
freshness and write permissions. Event replay detects inconsistency, not an
attacker rewriting an entire unsigned journal.

## Compatibility and limitations

New sessions save envelope version 2 with a required Task. Version 1 saves stay
on the old validated recovery path without invented events or automatic file
rewrites. Explicit Demo reset creates a fresh version 2 session. The old
`action` record remains a checked compatibility mirror in new sessions and the
authority for legacy sessions; it is not yet removed from all consumers.
Older dev.2 builds do not understand version 2 saves: do not downgrade against
the same data directory or delete records to make a downgrade start.

In the legacy/synchronous mock path, target and task commit together, so a pre-submit external checkpoint
is unnecessary for this wholly local operation. This is **not** proof of
exactly-once remote writes. Real connectors still require a durable pre-submit
checkpoint, reconciliation and controlled recovery before production use.

The price Demo now invokes the [local capability/connector slice](local-capabilities.md).
Stockout and fixed campaign mock execution are implemented. New asynchronous
price sessions use separately persisted checkpoints and targets; see
[async price sessions](async-price-session.md). Generic multi-item UI, full
rollback execution and desktop production RPA remain outside this release.
Private host binding does not imply migration of every Enterprise module. No real-store result
is claimed: WAITING_FOR_REAL_VALIDATION.
