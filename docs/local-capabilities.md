# Local capability and mock connector slice

The offline Demo's actual price write/read now goes through:

`Task → demo.price.write / demo.price.read → MockPriceConnector → target readback → Task verification`

`CapabilityRegistry` separates registration, preconditions, explicit write
authorization and invocation. There are no default platform capabilities.
Registration rejects duplicate IDs and incomplete declarations. Checks must
return exactly `true`; truthy objects or promises are not approval. Inputs and
context are copied between stages. A submit result is returned as a submit
result, never automatically converted to VERIFIED.

This version is a **synchronous local gateway**. `real_write` is always disabled,
even with caller-supplied flags. Async handlers/results are rejected; this is
not an async remote runtime, timeout mechanism, plugin sandbox or proof that
arbitrary third-party code cannot perform I/O. Only trusted application-owned
handlers may be registered. Remote execution needs durable checkpoints and
reconciliation rather than simply enabling a flag here.

The Demo composition root supplies its own authorizer. It binds the synthetic
store, current preview and exact target values to the persisted approval/run;
neither model output nor IPC supplies the authorizer or switches the connector.
Legacy v1 sessions continue through their validated original authorization.

`MockPriceConnector` owns a cloned synthetic price map. It validates the entire
batch (scope, unique targets, integer amounts, matching original values) before
changing any target. Missing read values are null, not zero. It has no files,
network, credentials, scheduler or real platform behavior. Its snapshot retains
the existing storage format. Demo rollback-on-error restores that local target
along with task state; optimistic SQLite revision conflicts still poison the
stale instance until reopening. This is not distributed exactly-once delivery.

The old commercial registry's registration/check/approval/invocation separation
was inspected and reused conceptually; its production imports/defaults and
broad risk-level approval flags were not copied. Commercial APIs are not yet
redirected to this module. Generic asynchronous Capability Gateway, full
Connector SDK, Agent and RPA integration remain unfinished.
