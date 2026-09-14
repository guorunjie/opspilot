# Target-state comparison (development)

`src/verification/verifyTargetState.js` is the shared integer-value comparator
used by the offline price readback and checkpoint validation. It checks exact
plan, connector and store identifiers before comparing unique target IDs.
Missing, null, non-integer or unsafe numeric observations are UNKNOWN, not zero.
Malformed scope, duplicate or unexpected target IDs invalidate the whole read.
An empty plan is rejected rather than vacuously verified.

Each expected target retains its expected value, observed value (or null), and
VERIFIED / FAILED / UNKNOWN outcome. Aggregation is all matching → VERIFIED;
some matching → PARTIALLY_VERIFIED; no matching with unknowns → UNKNOWN;
otherwise → FAILED. FAILED here means an observed target mismatch, not proof
that the submission itself failed. Never use this result to blindly resubmit.

This function compares supplied data. It does not authenticate a connector,
prove freshness, retrieve a platform result, authorize a write, or establish
real-platform provenance. Those remain caller/framework responsibilities.

The existing Demo v1 checkpoint and visible single-product flow are preserved:
its complete synthetic price map is compared through this module and projected
to the existing evidence/review format. The unavailable-read scenario still
persists UNKNOWN without a terminal review, and retry reads never resubmit.
Partial-result support is unit-tested here, **not yet a multi-product Demo or
the canonical persistent Task/VerificationResult model**. That migration and
the unified twelve-state task lifecycle remain outstanding. No production
connector or commercial dependency is introduced.

Development source is now 0.1.0-dev.3; the published dev.2 installers and tag
remain unchanged. This source change alone is not a new installer acceptance.
