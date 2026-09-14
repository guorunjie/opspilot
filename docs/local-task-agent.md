# Local Task Agent

`src/agent/localTaskAgent.js` orchestrates the existing canonical Task, rule
planner and Capability gateway. The current desktop price Demo uses it for
check → propose → approve → execute → readback → verify. This is synchronous
local orchestration, not a general LLM tool loop or production browser executor.

Application code supplies `getTask`, `checkpoint(next, previous)`,
`planner.proposePlan(input, { task, memory })`, `memory.read({ taskId, namespace })`,
and the gateway plus fixed write/read capability IDs. Inputs and outputs are
cloned. Planner output supplies only proposed target items; its claims about
approval, capability selection, completion or verification confer no authority.
The application must validate business policy and provenance before exposing a
proposal and only call `approve` from a genuine explicit user confirmation.
Application hooks are trusted code, not sandboxed third-party plugins.

The runtime records EXECUTING before invocation, then SUBMITTED or UNKNOWN,
never VERIFIED from submission. It records VERIFYING before invoking the
read-only capability and delegates target comparison to the canonical Task.
Missing observations and partial matches retain their respective states.
Gateway exceptions preserve UNKNOWN. `recover()` converts interrupted execution
or verification to UNKNOWN without writing to the target; reconciliation is a
separate `verify()` call. No method automatically resubmits an uncertain run.

Checkpoint failure poisons that runtime instance. Reopen against the actual
persisted record, then reconcile. A standalone checkpoint implementation must
atomically compare-and-save against `previous`, acknowledge the saved value,
and retain the pre-invocation checkpoint on subsequent errors. The Demo instead
stages these events inside its existing atomic task-plus-mock-target SQLite
transaction: this is safe only for its wholly local synchronous mock. Its
legacy v1 checkpoints retain the previous validated route until explicit reset.

Memory is read-only planning context; in the Demo it is the current task's
persisted history. No cross-store learning, credential loading, automatic
approval or production defaults are introduced. Real-write capabilities are
rejected, including when placed in the read role. Async hooks are rejected;
returning a Promise from an ordinary function is also rejected but cannot undo
side effects already started by trusted hook code.

Still pending: durable asynchronous Agent execution, structured multi-intent
planning, richer Memory adapters, browser/RPA integration, stockout and campaign
execution, Enterprise dependency migration and real-store validation. These
local tests and the offline Demo do not prove those requirements complete.
