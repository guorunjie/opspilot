import { createHash } from 'node:crypto';
const string = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const keys = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).every(key => allowed.includes(key));

export function compileBrowserWorkflow(input) {
  if (!keys(input, ['version', 'id', 'steps']) || input.version !== 1 || !string(input.id, 128)
    || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 100)
    throw new TypeError('Invalid bounded workflow');
  const seen = new Set();
  const steps = Array.from(input.steps, step => {
    if (!keys(step, ['id', 'type', 'selector', 'value']) || !string(step.id, 128) || seen.has(step.id)
      || !['assertText', 'readText', 'fill', 'click'].includes(step.type) || !string(step.selector, 2048))
      throw new TypeError('Invalid or duplicate workflow step');
    seen.add(step.id);
    const needsValue = ['assertText', 'fill'].includes(step.type);
    if (needsValue ? typeof step.value !== 'string' || step.value.length > 10000 : Object.hasOwn(step, 'value'))
      throw new TypeError('Invalid step value');
    return Object.freeze({ id: step.id, type: step.type, selector: step.selector, ...(needsValue ? { value: step.value } : {}) });
  });
  const definition = Object.freeze({ version: 1, id: input.id, steps: Object.freeze(steps) });
  return Object.freeze({ definition, digest: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    riskLevel: steps.some(step => ['fill', 'click'].includes(step.type)) ? 'simulated_write' : 'readonly' });
}

// Fixed, reviewed workflow definitions are supplied by trusted Connectors.
// The authorizer must bind definition digest + context to current Task approval.
export async function runBrowserWorkflow({ runtime, workflow, context, preconditions, authorize,
  onStep = async () => {}, signal }) {
  const compiled = compileBrowserWorkflow(workflow);
  if (typeof runtime?.run !== 'function' || runtime.snapshot?.().offline !== true
    || typeof preconditions !== 'function' || typeof onStep !== 'function'
    || (compiled.riskLevel !== 'readonly' && typeof authorize !== 'function'))
    throw new TypeError('Offline runtime and explicit workflow gates required');
  const ctx = structuredClone(context);
  const gateInput = () => ({ workflow: structuredClone(compiled), context: structuredClone(ctx) });
  const trace = [], outputs = [];
  let mutationPossible = false;
  const emit = async (step, phase) => {
    const event = { workflowId: compiled.definition.id, digest: compiled.digest, stepId: step.id, phase, at: new Date().toISOString() };
    await onStep(structuredClone(event)); trace.push(event);
  };
  try {
    if (await preconditions(gateInput()) !== true) throw new Error('Workflow preconditions rejected');
    return await runtime.run(async page => {
      for (const step of compiled.definition.steps) {
        signal?.throwIfAborted();
        const write = ['fill', 'click'].includes(step.type);
        if (write && await authorize(gateInput()) !== true) throw new Error('Workflow lacks current scoped approval');
        await emit(step, 'STARTED');
        signal?.throwIfAborted();
        const locator = page.locator(step.selector);
        if (await locator.count() !== 1) throw new Error('Workflow target missing or ambiguous');
        if (write) {
          // The checkpoint/audit await above can allow revocation; check again.
          if (await authorize(gateInput()) !== true) throw new Error('Workflow approval changed');
          signal?.throwIfAborted(); mutationPossible = true;
          if (step.type === 'fill') await locator.fill(step.value);
          else await locator.click();
        } else {
          const value = await locator.textContent();
          if (typeof value !== 'string') throw new Error('Workflow read unavailable');
          if (step.type === 'assertText' && value !== step.value) throw new Error('Workflow assertion mismatch');
          outputs.push({ stepId: step.id, value });
        }
        await emit(step, 'COMPLETED');
      }
      return { status: 'COMPLETED', digest: compiled.digest, outputs, trace, simulated: true };
    }, { signal });
  } catch (cause) {
    throw Object.assign(new Error('Browser workflow stopped', { cause }), {
      mutationState: mutationPossible ? 'possibly_started' : 'not_started',
      executionMayContinue: cause?.executionMayContinue === true, trace: structuredClone(trace)
    });
  }
}
