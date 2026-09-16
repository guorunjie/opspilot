import { createConnectorManifest } from '../connector/connectorManifest.js';
import { compileBrowserWorkflow, runBrowserWorkflow } from './browserWorkflow.js';

// DS053 draft, corrected after contract review. Trusted hooks, not a sandbox.
// Local simulated only. The calling Task owns durable locking and recovery.
export function createConnectorWorkflowCapability({ manifest, capabilityId, workflow,
  runtime, preconditions, authorize, validateCurrent, onStep = async () => {} }) {
  const canonical = createConnectorManifest(manifest);
  const selected = canonical.capabilities.find(cap => cap.id === capabilityId);
  if (!selected || selected.execution !== 'local' || selected.simulated !== true
    || !['read', 'write'].includes(selected.operation))
    throw new TypeError('A declared local simulated read/write capability is required');
  const compiled = compileBrowserWorkflow(workflow);
  if ((selected.operation === 'read') !== (compiled.riskLevel === 'readonly'))
    throw new TypeError('Declared operation and workflow risk do not match');
  if (typeof runtime?.run !== 'function' || runtime.snapshot?.().offline !== true
    || typeof preconditions !== 'function' || typeof validateCurrent !== 'function'
    || validateCurrent.constructor?.name === 'AsyncFunction' || typeof onStep !== 'function'
    || (selected.operation === 'write' && typeof authorize !== 'function'))
    throw new TypeError('Offline runtime and current scoped gates required');
  const binding = Object.freeze({ connectorId: canonical.id, capabilityId,
    workflowId: compiled.definition.id, digest: compiled.digest });

  function capture(inputs, context = {}) {
    if (!context || typeof context !== 'object' || Array.isArray(context))
      throw new TypeError('Context must be an object');
    const { signal, ...rest } = context;
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw new TypeError('AbortSignal required');
    const payload = structuredClone(inputs), ctx = structuredClone(rest);
    return { signal, args: () => ({ binding, inputs: structuredClone(payload),
      context: { ...structuredClone(ctx), signal } }) };
  }
  function current(call) {
    call.signal?.throwIfAborted();
    const value = validateCurrent(call.args());
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      throw new TypeError('Current-state guard must be synchronous');
    }
    return value === true;
  }
  async function gate(hook, call) {
    call.signal?.throwIfAborted();
    if (await hook(call.args()) !== true) return false;
    return current(call);
  }
  return Object.freeze({
    id: `${canonical.id}:${capabilityId}`,
    riskLevel: compiled.riskLevel,
    preconditions: (inputs, context) => gate(preconditions, capture(inputs, context)),
    authorize: selected.operation === 'write'
      ? (inputs, context) => gate(authorize, capture(inputs, context)) : undefined,
    validateCurrent: (inputs, context) => current(capture(inputs, context)),
    async run(inputs, context) {
      const call = capture(inputs, context);
      const result = await runBrowserWorkflow({ runtime, workflow: compiled.definition,
        context: undefined, signal: call.signal, onStep,
        preconditions: () => gate(preconditions, call),
        authorize: selected.operation === 'write' ? () => gate(authorize, call) : undefined });
      // Cancellation during the final step must not appear as a completed call.
      // Await the original operation first; abort alone does not stop a write.
      if (call.signal?.aborted) throw Object.assign(new Error('Workflow interrupted after invocation'), {
        mutationState: selected.operation === 'write' ? 'possibly_started' : 'not_started', trace: result.trace
      });
      return result;
    }
  });
}
