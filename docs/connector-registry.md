# Trusted Connector registry

Development interface, not part of the frozen v0.1.0 tag. Import createConnectorRegistry from `opspilot/connector-registry` using a reviewed commit that includes it.

The trusted host explicitly registers a validated manifest and optionally a read-only `probe` callback. No auto-discovery, dynamic plugin loading, credential collection, network client, executor or default Connector is provided. The callback is trusted host code, not sandboxed; never expose registration to a renderer. It receives no arguments or internal registry object.

Use `list()` for immutable metadata. `inspect(id, {configuredKeys, now, maxAgeMs})` assesses the last observation without invoking anything. `probe(id, options)` validates configuration key names and time before invoking the registered hook. The hook returns `{status: 'available'|'unavailable'|'unknown', checkedAt}`; checkedAt must be the adapter's observation timestamp, not a fabricated success timestamp. Missing/stale/future observations remain UNKNOWN. Caller time is captured at invocation, so a later observation may conservatively stay UNKNOWN until a subsequent inspect.

Config values stay in the host. Changing the identity/configuration behind a registered callback requires a fresh registry: cached probe evidence is not bound to credential values or a store identity. Readiness does not authorize actions or verify business results. Configuration persistence, identity-scoped production probes and desktop wiring remain separate work, not implied by this contract.

Only one actual probe per Connector may run at once. No automatic retry or timeout falsely releases the fence; an unresolved hook keeps the entry busy. Errors and malformed results clear prior success and report UNKNOWN without leaking exceptions. Missing configuration avoids invoking the hook. Existing platform action confirmation, rejection, idempotency, locks and evidence verification remain unchanged.

DS-031/032 drafted implementation, DS-031/033 drafted tests; GPT rejected incorrect validation ordering and test expectations, corrected integration and reviewed the boundary. Difference tests cover registered metadata, stale/failed probes, immutable inputs and concurrency; no real platform was launched. This is an extension API, not proof of a working production Connector or desktop installation.
