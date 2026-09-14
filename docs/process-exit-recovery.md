# Abrupt Demo process exit: evidence and remaining work

`test/asyncDemoProcessExit.test.js` runs a real Node child against a temporary SQLite database and exits it without application cleanup at two durable boundaries: Task EXECUTING saved, and synthetic target saved before acknowledgement. The parent requires the exact child's exit code before using the existing explicit abandoned-owner release API.

Both shell and price ownership survive. A reopened composition refuses execution and reset. Recovery without a termination confirmation is rejected. Once the test supervisor has confirmed termination, the lower-level price recovery transitions to UNKNOWN and independent readback yields FAILED for an unchanged target or VERIFIED for a matching target. Submission count stays respectively zero or one; the task cannot execute again. This is synthetic target verification, not a real platform result.

This test is not a desktop recovery feature, an OS power-loss test, or permission for users to edit ownership rows. The application still lacks a user-facing path to establish safe recovery authority. An elapsed timeout or a user's click alone cannot prove that a previous executor has stopped.

Next vertical slice must combine trusted application-instance ownership/termination evidence, a read-only interruption summary, explicit recovery confirmation, release of only the exact abandoned claims, UNKNOWN transition and readback, and continued rejection of duplicate execution. Cover a still-live competing instance, stale tokens, interrupted recovery itself and the separate reservation-before-START boundary. Preserve old archives and real-write isolation. Do not expose a generic unlock command to the renderer.

Local baseline after adding these tests: 195 tests passed. Packaged GUI recovery and real-store validation remain incomplete.
