# Connector Foundation source v0.1.1

This is a source/API increment, not a new production desktop installer. The existing v0.1.0 Windows/macOS offline Demo binaries and their original acceptance remain unchanged. Never substitute a Demo result for real-platform evidence.

## Public capabilities

- `opspilot/connector-manifest`: validated immutable metadata and conservative readiness assessment.
- `opspilot/connector-registry`: trusted host registration, explicit read-only probe hooks, stale/error invalidation and per-Connector in-flight protection.
- Existing `opspilot/host-execution-binding` and `opspilot/platform-action-protocol` exports remain available. Binding fingerprints associate results; they neither authorize execution nor imply VERIFIED.

The registry is independently usable without Enterprise. A community host provides its own authorized read-only adapter callback and keeps credentials outside Core. There is no dynamic untrusted plugin loader, bundled production Connector, automatic login, or automatic write. Registration does not prove callback safety; the integrating host is responsible for authorization and its execution environment.

READY only describes a fresh supplied observation. A production host must additionally bind platform and store identity and discard cached state when identity/configuration changes. The generic registry does not invent observed IDs, establish identity from names, or verify business outcomes.

## Acceptance inheritance and differences

Inherited: unchanged v0.1.0 offline desktop paths and original installation evidence; historical three-platform acceptance belongs to the private production host, not this public source package. Historical raw JSON/install receipt linkage gaps are still gaps, not grounds to repeat live actions or assume fresh acceptance.

Differences already checked for the interface commits: 20 manifest tests; 28 registry/safety tests; explicit package exports and independent packed imports; Windows/macOS/Linux source CI. This release changes version metadata and documentation only beyond those reviewed interface commits. The v0.1.1 package version, Apache-2.0 license, absence of production dependencies and all four packed exports were checked. No repeat of real-platform runs or unchanged desktop installation cases was needed.

Not verified: community-provided production adapters, real storefront identity observations in this increment, or a new desktop installation. Ordinary-user independent use remains unverified and is excluded from this acceptance at the user's direction, not counted as passed.

External dependencies: commercial platform Connectors, Recipes, Selectors, credentials and customer configuration remain outside Open Core. A host may expose read-only status in its existing desktop, but this source release does not ship that proprietary desktop or advertise live store readiness.

Later work: richer configuration UX, additional provider adapters and stronger live identity telemetry only under their own scoped review. No ROI, attribution, new platforms, unattended writes or full UI rewrite are added to this release.
