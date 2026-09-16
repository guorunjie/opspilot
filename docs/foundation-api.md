# Foundation API (UNRELEASED)

> **Status: unreleased.** This API is **not** in published `v0.1.1` and is **not** published to any npm registry. Do not claim it as released. Pin the reviewed source commit after merge, or use an explicit candidate package.

Requires **Node >= 24**. A built-in SQLite warning may appear.

## Integration sequence

1. **Manifest read** — trusted registered manifest read capability with `createSourceReader({ manifest, capabilityId, read, authorizeRead, validateCurrent, clock })`. Hooks are supplied by the trusted host; `validateCurrent` must be synchronous.
2. **Collect** — `reader.collect({ scope, maxAgeMs, signal })` → flat normalized data.
3. **Diagnose** — `reader.diagnose({ ...same, minimumMargin })` → `{ observation, opportunities, excluded }`.
4. **Prepare task** — `prepareSourceOpportunityTask({ input: raw, options: { expectedScope, now, maxAgeMs }, opportunityId, taskId, planId, namespace })`.

The raw, exact observation is **required** as `input`. Never pass normalized `collect` output as the raw input. The trusted host owns the original scoped raw snapshot; stale or wrong-scope data yields **UNKNOWN** and no plan. Malformed required fields throw a validation error; missing numeric values remain null, not zero.

5. The facade **recomputes** the proposal and returns an **unapproved** task with evidence in `task.plan.sourceEvidence`.
6. **Persist** each task history event through the existing checkpoint. **No approval is synthesized.**
7. **Workflow** — the factory accepts local simulated capabilities only, via the existing offline runtime. A recorded workflow digest is **not** an approval. Uncertain execution does **not** auto-replay.
8. **Compensation** — the factory only **previews** exact current state and requires separate approval. Host dispatch is **not implemented** by this facade.

## Boundary rules

- Actual private writes stay in the original action-run / auth / confirmation / refusal / idempotency / locks path.
- Core never imports Enterprise.
- Data, SHA, and probe-ready signals are **not** authenticity, authorization, or `VERIFIED`.
- Credentials, customer data, private configuration values and production connector recipes must never be published.
- Ordinary-user independent use stays **unverified** and excluded.
- Host/UI full integration and installer delivery are **NOT complete**.

## Exported surface (12)

| Area | Functions |
|---|---|
| Source | `createSourceReader`, `prepareSourceOpportunityTask`, `prepareCompensationPreview` |
| Connector | `createConnectorWorkflowCapability`, `AsyncCapabilityRegistry` |
| Task/store | `createTask`, `advanceTask`, `openPersistentTask`, `openStateStore` |
| Workflow | `compileBrowserWorkflow`, `workflowFromRecording`, `startWorkflowRecorder` |

No other functions are part of this facade.
