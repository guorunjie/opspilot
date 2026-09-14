# Abrupt Demo process exit: implementation and acceptance

## Current scope

These are development changes after the immutable `v0.1.0-dev.4` release, not an installed-version upgrade or completed desktop recovery feature. Real-store validation remains `WAITING_FOR_REAL_VALIDATION`.

The desktop records an installation identity and the owning process for new asynchronous Demo claims. It explains unresolved ownership and disables mutation controls, but does **not** automatically release abandoned claims or expose a recovery/unlock command.

## Implemented boundaries

- Before readiness or opening SQLite, Electron requests a single-instance lock using the stable Core-only `appData/opspilot-open-core/desktop-runtime` directory. A rejected second launch exits before data access. The primary restores its window and ignores forwarded arguments. Browser session data remains temporary and isolated.
- `loadLocalExecutorIdentity` exclusively creates and fsyncs `desktop-runtime/host-identity.json`, outside portable `offline-demo` data. Subsequent launches retain the installation UUID but receive a fresh instance UUID and current PID. Invalid, partial, oversized or linked identity files and linked directory components are rejected without replacement.
- The desktop passes this identity through `createDesktopDemo` to asynchronous shell, price and reset claims. `createTaskOwnership` atomically saves `{pid, instanceId, hostId}` with the ownership token in a version-2 claim. Reads validate and clone the identity; release clears it. Legacy claims remain version 1 and are never assigned inferred identities. The legacy Demo engine is unchanged. Older readers reject version-2 claims rather than interpreting them silently.
- Price execution saves durable Task START before reserving the scenario. Reservation failure prevents target writes and poisons the current handle. This prevents new pre-START stranded reservations; it does not migrate historical ones.
- Read-only snapshots report unresolved foreign claims or interrupted EXECUTING/VERIFYING tasks without exposing tokens or executor identity. Saved evidence remains readable; mutation controls are disabled. Locally owned in-flight operations are not described as abandoned.

An installation UUID is not hardware attestation. Do not export its file with Demo databases: copying both defeats host separation. Filesystem preflight is not protection against hostile concurrent path replacement. The Electron lock does not cover older binaries or arbitrary non-Electron writers, and alone never authorizes releasing claims.

## Presence inspection is not recovery authorization

`inspectExecutorPresence` is a source-only prerequisite, not yet wired into the desktop or its package. It probes only validated same-host identities with signal zero. Only ESRCH produces ABSENT. A successful presence check produces PRESENT; mismatched hosts, permission errors, unexpected returns or asynchronous probes produce UNKNOWN. A reused live PID conservatively blocks recovery.

This evidence is limited to same-process offline work. It does not establish termination of spawned workers, browser children or remote/production operations. Neither elapsed time nor a user's confirmation alone proves termination.

## Verified development evidence

- Full local suite: **207 tests passed**. Identity tests cover persistence, fresh instances, independent installation directories, corruption preservation, hard-link rejection and caller-alias isolation. Composition tests inspect acquired shell/price/reset claims and confirm identities are omitted from snapshots.
- `test/asyncDemoProcessExit.test.js` exits a real Node child without cleanup at three durable boundaries: Task START, scenario reservation, and synthetic target write before acknowledgement. Both claims survive; reopen refuses execution/reset. Only after the supervisor observes that exact child's termination does the test invoke lower-level reconciliation. Recovery moves the task to UNKNOWN; independent readback yields FAILED for the unchanged target or VERIFIED for a matching synthetic target. Submission counts remain zero or one and execution cannot repeat.
- Windows **source Electron** regression passed all four price scenarios, approval/submission close-and-reopen preservation, normal supplemental inventory/campaign flows, and reset cancel/confirm. The mismatch review viewport was visually checked: FAILED, expected 18 versus observed 20, submission count one.
- Windows source two-process testing passed: secondary exit zero, primary window restored, forwarded execution arguments ignored, unchanged snapshot, and normal reopen reacquiring the lock.
- A synthetic unreleased legacy claim produced the recovery banner, disabled mutation controls, and unchanged SQLite rows/revisions. This tests the blocked-state explanation, not a recovery action.
- `npm run desktop:pack` completed for Windows x64. All 30 non-manifest allowlisted source files were extracted from the actual ASAR and matched local bytes, including the identity loader and its dependencies. This is package-content verification, **not packaged runtime or installer acceptance** for these changes.

Tests use independent temporary data; the existing local installation and its reviews were not upgraded or reset. These results do not establish macOS acceptance for the new identity integration, OS power-loss durability, non-developer usability or real-platform execution.

## Next required vertical slice

Implement main-process-only recovery authority and explicit user confirmation, with fresh identity/presence and exact-token checks, interruption-safe reconciliation, an UNKNOWN transition and independent readback. Never expose generic unlock or trust a renderer-provided termination Boolean. Cover a live competing executor, unknown/foreign/legacy identities, stale tokens, a crash during recovery, and historical pre-START reservations. Preserve archives and reject duplicate execution throughout.

Then verify actual packaged Windows and macOS behavior and an abrupt desktop-process exit. Until those checks pass, safe desktop recovery remains incomplete.
