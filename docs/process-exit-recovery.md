# Abrupt Demo process exit: implementation and acceptance

## Current scope

These are development changes after the immutable `v0.1.0-dev.4` release, not an installed-version upgrade. The source desktop now has a scoped recovery path; packaged and macOS recovery acceptance remain pending. Real-store validation remains `WAITING_FOR_REAL_VALIDATION`.

The desktop records an installation identity and the owning process for new asynchronous Demo claims. It explains unresolved ownership and disables mutation controls. When every held claim belongs to a confirmed absent process on this installation, it offers **恢复待核实记录（不重新提交）**. This is not an automatic or generic unlock.

## Implemented boundaries

- Before readiness or opening SQLite, Electron requests a single-instance lock using the stable Core-only `appData/opspilot-open-core/desktop-runtime` directory. A rejected second launch exits before data access. The primary restores its window and ignores forwarded arguments. Browser session data remains temporary and isolated.
- `loadLocalExecutorIdentity` exclusively creates and fsyncs `desktop-runtime/host-identity.json`, outside portable `offline-demo` data. Subsequent launches retain the installation UUID but receive a fresh instance UUID and current PID. Invalid, partial, oversized or linked identity files and linked directory components are rejected without replacement.
- The desktop passes this identity through `createDesktopDemo` to asynchronous shell, price and reset claims. `createTaskOwnership` atomically saves `{pid, instanceId, hostId}` with the ownership token in a version-2 claim. Reads validate and clone the identity; release clears it. Legacy claims remain version 1 and are never assigned inferred identities. The legacy Demo engine is unchanged. Older readers reject version-2 claims rather than interpreting them silently.
- Price execution saves durable Task START before reserving the scenario. Reservation failure prevents target writes and poisons the current handle. This prevents new pre-START stranded reservations; it does not migrate historical ones.
- Read-only snapshots report unresolved foreign claims or interrupted EXECUTING/VERIFYING tasks without exposing tokens or executor identity. Saved evidence remains readable; mutation controls are disabled. Locally owned in-flight operations are not described as abandoned.

An installation UUID is not hardware attestation. Do not export its file with Demo databases: copying both defeats host separation. Filesystem preflight is not protection against hostile concurrent path replacement. The Electron lock does not cover older binaries or arbitrary non-Electron writers, and alone never authorizes releasing claims.

## Presence inspection and explicit recovery

`inspectExecutorPresence` is wired into the trusted Demo composition and included in the desktop package. It probes only validated same-host identities with signal zero. Only ESRCH produces ABSENT. A successful presence check produces PRESENT; mismatched hosts, permission errors, unexpected returns or asynchronous probes produce UNKNOWN. A reused live PID conservatively blocks recovery.

This evidence is limited to same-process offline work. It does not establish termination of spawned workers, browser children or remote/production operations. Neither elapsed time nor a user's confirmation alone proves termination.

The main process opens a native confirmation dialog with cancellation as the default. It ignores renderer-supplied confirmation, tokens and termination assertions. After confirmation, the composition checks current claims and process presence again. Each exact abandoned claim is replaced with the current executor's claim by a conditional atomic write, without an unlocked gap. Shell ownership encloses price reconciliation; EXECUTING/VERIFYING transitions to UNKNOWN without invoking a gateway. Completed task states are preserved. Recovery itself never submits or reads a target; the user then requests independent readback through the usual button.

A changed claim or uncertain write acknowledgement fails closed. Uncertain recovery checkpoints retain claims; the poisoned handle requires reopening, and a still-live recovery process cannot be taken over. A crash between shell takeover, price takeover and the UNKNOWN checkpoint can be reconciled on a later launch. Interrupted tasks missing price ownership proof, legacy/foreign claims and live processes remain blocked. Do not manually edit ownership records.

## Verified development evidence

- Full local suite: **220 tests passed**. Identity tests cover persistence, fresh instances, independent installation directories, corruption preservation, hard-link rejection and caller-alias isolation. Composition tests inspect acquired shell/price/reset claims and confirm identities are omitted from snapshots.
- Additional real Node-child exit tests cover BEGIN_VERIFY and a saved VERIFIED checkpoint before ownership release. The former recovers to UNKNOWN and independently reads again without resubmitting; the latter preserves the exact task history, verification evidence and review instead of downgrading a verified result. These are not packaged desktop tests.
- `test/asyncDemoProcessExit.test.js` exits a real Node child without cleanup at three durable boundaries: Task START, scenario reservation, and synthetic target write before acknowledgement. Both claims survive; reopen refuses execution/reset. Only after the supervisor observes that exact child's termination does the test invoke lower-level reconciliation. Recovery moves the task to UNKNOWN; independent readback yields FAILED for the unchanged target or VERIFIED for a matching synthetic target. Submission counts remain zero or one and execution cannot repeat.
- Windows **source Electron** regression passed all four price scenarios, approval/submission close-and-reopen preservation, normal supplemental inventory/campaign flows, and reset cancel/confirm. The mismatch review viewport was visually checked: FAILED, expected 18 versus observed 20, submission count one.
- Windows source two-process testing passed: secondary exit zero, primary window restored, forwarded execution arguments ignored, unchanged snapshot, and normal reopen reacquiring the lock.
- A synthetic unreleased legacy claim produced the recovery banner, disabled mutation controls, and unchanged SQLite rows/revisions. This tests the blocked-state explanation, not legacy recovery.
- `test/asyncDemoRecovery.test.js` verifies bound dead-process recovery at START/reservation/target-write, a second crash at shell takeover/price takeover/UNKNOWN checkpoint, refusal of live/foreign/legacy claims, and retained claims after a lost checkpoint acknowledgement. Ownership tests reject stale tokens, asynchronous or false proof, and a claim changed during proof. Desktop boundary tests exercise native dialog cancellation/confirmation, mutation fencing during the dialog and rejection of renderer proof.
- Windows source Electron was force-terminated at START, reservation and synthetic target write in an isolated test composition. The default desktop entry then reopened the records, offered recovery, preserved them on cancellation, moved interrupted tasks to UNKNOWN on confirmation, preserved that state across another restart, and independently read back FAILED/count 0, FAILED/count 0 and VERIFIED/count 1 respectively. The ready/review viewports were inspected. Dialog answers were controlled by the test: native dialog rendering and human interaction are **not** verified by this test. The initial experiment with Electron's graceful exit request let execution finish, so it was rejected as crash evidence and replaced with force termination.
- `npm run desktop:pack` completed for Windows x64. All 31 non-manifest allowlisted source files were extracted from the actual ASAR and matched local bytes. This is package-content verification, **not packaged runtime or installer acceptance** for these changes.

Tests use independent temporary data; the existing local installation and its reviews were not upgraded or reset. These results do not establish macOS acceptance for the new identity integration, OS power-loss durability, non-developer usability or real-platform execution.

## Next required vertical slice

Verify actual packaged Windows and macOS recovery behavior and native confirmation interaction, including interrupted readback. Extend storage-failure coverage. Historical pre-START reservations and legacy/unbound interruption recovery require a separate explicit reconciliation design; they are not made safe by this implementation. Preserve archives and reject duplicate execution throughout.

Until the remaining checks pass, do not claim full desktop recovery acceptance or upgrade the immutable dev.4 release in place.
