// DS054 cases; GPT corrected API arguments, rejection semantics and vacuous assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorWorkflowCapability } from '../src/rpa/connectorWorkflow.js';
import { compileBrowserWorkflow } from '../src/rpa/browserWorkflow.js';
import { AsyncCapabilityRegistry } from '../src/capability/asyncCapabilityRegistry.js';

const ID = 'example:price';
const declaration = { id: 'price', label: 'Price', operation: 'write', execution: 'local', simulated: true };
const manifest = (cap = {}) => ({ schemaVersion: 1, id: 'example', label: 'Example', version: '0.1.0',
  platformIds: ['p'], requiredConfigKeys: [], capabilities: [{ ...declaration, ...cap }] });
const workflow = () => ({ version: 1, id: 'change', steps: [{ id: 'submit', type: 'click', selector: '#submit' }] });
function fixture(over = {}, fail = false) {
  let clicks = 0;
  const selectors = [];
  const runtime = { snapshot: () => ({ offline: true }), run: async fn => fn({ locator: selector => {
    selectors.push(selector);
    return { count: async () => 1, textContent: async () => '', click: async () => {
      clicks++; if (fail) throw new Error('lost response');
    } };
  } }) };
  const cap = createConnectorWorkflowCapability({ manifest: manifest(), capabilityId: 'price',
    workflow: workflow(), runtime, preconditions: () => true, authorize: () => true,
    validateCurrent: () => true, ...over });
  const registry = new AsyncCapabilityRegistry([cap]);
  return { cap, registry, selectors, get clicks() { return clicks; } };
}

test('registry invocation binds actual declaration and never reports business verification', async () => {
  const seen = [];
  const signal = new AbortController().signal;
  const f = fixture({ authorize: args => { seen.push(args); return true; } });
  const result = await f.registry.invoke(ID, { binding: { connectorId: 'impostor' } }, { signal });
  assert.ok(Object.isFrozen(f.cap));
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.simulated, true);
  assert.equal(result.verified, undefined);
  assert.equal(f.clicks, 1);
  assert.ok(seen.length > 0);
  for (const args of seen) {
    assert.deepEqual(args.binding, { connectorId: 'example', capabilityId: 'price',
      workflowId: 'change', digest: compileBrowserWorkflow(workflow()).digest });
    assert.ok(Object.isFrozen(args.binding));
    assert.equal(args.context.signal, signal);
  }
});

test('factory captures definition; later caller mutation cannot change digest or targets', async () => {
  const definition = workflow(), digest = compileBrowserWorkflow(definition).digest;
  const f = fixture({ workflow: definition });
  definition.steps[0].selector = '#evil';
  definition.steps.push({ id: 'extra', type: 'click', selector: '#evil2' });
  const result = await f.registry.invoke(ID, { workflow: definition });
  assert.equal(result.digest, digest);
  assert.deepEqual(f.selectors, ['#submit']);
  assert.equal(f.clicks, 1);
});

test('rejects undeclared, host, non-simulated, compensation and operation mismatch', () => {
  assert.throws(() => fixture({ capabilityId: 'missing' }));
  for (const change of [{ execution: 'host' }, { simulated: false }, { operation: 'compensate' }, { operation: 'read' }])
    assert.throws(() => fixture({ manifest: manifest(change) }));
  assert.throws(() => fixture({ runtime: { run() {}, snapshot: () => ({ offline: false }) } }));
});

test('revocation across authorization await or checkpoint prevents click', async () => {
  for (const atCheckpoint of [false, true]) {
    let current = true;
    const f = fixture({ validateCurrent: () => current,
      authorize: async () => { if (!atCheckpoint) { await Promise.resolve(); current = false; } return true; },
      onStep: event => { if (atCheckpoint && event.phase === 'STARTED') current = false; } });
    await assert.rejects(f.registry.invoke(ID, {}));
    assert.equal(f.clicks, 0);
  }
});

test('thenable current-state guard rejects without unhandled rejection or click', async () => {
  const f = fixture({ validateCurrent: () => Promise.reject(new Error('invalid asynchronous guard')) });
  await assert.rejects(f.registry.invoke(ID, {}), /synchronous/);
  assert.equal(f.clicks, 0);
});

test('failed click is possibly started and is never retried', async () => {
  const f = fixture({}, true);
  await assert.rejects(f.registry.invoke(ID, {}), error => error.mutationState === 'possibly_started');
  assert.equal(f.clicks, 1);
});

test('abort during outstanding final click waits for settlement and never retries or reports completion', async () => {
  let enter, finish, calls = 0, settled = false;
  const entered = new Promise(resolve => { enter = resolve; });
  const running = new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const f = fixture({ runtime: { snapshot: () => ({ offline: true }), run: async fn => fn({
    locator: () => ({ count: async () => 1, click: async () => { calls++; enter(); await running; } })
  }) } });
  const pending = f.cap.run({}, { signal: controller.signal });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await entered; controller.abort(); await Promise.resolve();
  assert.equal(settled, false);
  finish();
  await assert.rejects(pending, error => error.mutationState === 'possibly_started');
  assert.equal(calls, 1);
});

test('direct run snapshots caller input/context before asynchronous preconditions', async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const seen = [];
  const inputs = { value: 'original' }, context = { store: 'original' };
  const observe = ({ inputs: i, context: c }) => { seen.push([i.value, c.store]); return true; };
  const f = fixture({ preconditions: () => gate, authorize: observe, validateCurrent: observe });
  const pending = f.cap.run(inputs, context);
  inputs.value = 'mutated'; context.store = 'mutated'; resume(true);
  await pending;
  assert.ok(seen.length > 0);
  for (const item of seen) assert.deepEqual(item, ['original', 'original']);
});

test('read-only declaration preserves empty text and requires no write authorization', async () => {
  const f = fixture({ manifest: manifest({ operation: 'read' }), authorize: undefined,
    workflow: { version: 1, id: 'read', steps: [{ id: 'value', type: 'readText', selector: '#value' }] } });
  const result = await f.registry.invoke(ID, {});
  assert.deepEqual(result.outputs, [{ stepId: 'value', value: '' }]);
  assert.equal(f.clicks, 0);
});

test('direct call rejects invalid signals and gate-side mutation is isolated', async () => {
  let checked = 0;
  const f = fixture({ preconditions: ({ inputs, context }) => { inputs.value = 'bad'; context.store = 'bad'; return true; },
    validateCurrent: ({ inputs, context }) => {
      assert.equal(inputs.value, 'original'); assert.equal(context.store, 'original'); checked++; return true;
    } });
  await assert.rejects(f.cap.run({}, { signal: {} }), /AbortSignal/);
  await f.cap.run({ value: 'original' }, { store: 'original' });
  assert.ok(checked > 0);
});
