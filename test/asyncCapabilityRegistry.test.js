import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncCapabilityRegistry } from '../src/capability/asyncCapabilityRegistry.js';
const capability = overrides => ({ id: 'write', riskLevel: 'simulated_write',
  preconditions: async () => true, authorize: async () => true, validateCurrent: () => true,
  run: async () => ({ status: 'SUBMITTED' }), ...overrides });

test('async gateway validates registration and never enables real writes through context', async () => {
  assert.throws(() => new AsyncCapabilityRegistry([capability({ validateCurrent: async () => true })]));
  const registry = new AsyncCapabilityRegistry([capability({ riskLevel: 'real_write', run: () => assert.fail('must not run') })]);
  assert.throws(() => registry.register(capability()));
  await assert.rejects(registry.invoke('absent', {}), /Unknown/);
  await assert.rejects(registry.invoke('write', {}, { allowRealWrites: true }), /disabled/);
});

test('async checks receive detached data, unchanged signal and return only submission', async () => {
  const input = { value: 1 }, context = { nested: { value: 2 }, signal: new AbortController().signal };
  const result = { status: 'SUBMITTED' };
  const registry = new AsyncCapabilityRegistry([capability({
    preconditions: async (payload, ctx) => { payload.value = 99; ctx.nested.value = 99; return true; },
    authorize: async (payload, ctx) => { assert.equal(payload.value, 1); assert.equal(ctx.nested.value, 2); return true; },
    run: async (payload, ctx) => { assert.equal(payload.value, 1); assert.equal(ctx.signal, context.signal); return result; }
  })]);
  const received = await registry.invoke('write', input, context);
  assert.deepEqual(received, { status: 'SUBMITTED' });
  received.status = 'changed'; assert.equal(result.status, 'SUBMITTED');
  assert.equal(context.nested.value, 2); assert.equal(input.value, 1);
  registry.get('write').riskLevel = 'readonly'; assert.equal(registry.get('write').riskLevel, 'simulated_write');
});

test('revocation during asynchronous authorization fails the final guard', async () => {
  let approved = true, writes = 0;
  const registry = new AsyncCapabilityRegistry([capability({
    authorize: async () => { await Promise.resolve(); approved = false; return true; },
    validateCurrent: () => approved, run: () => { writes++; }
  })]);
  await assert.rejects(registry.invoke('write', {}), /current-state/);
  assert.equal(writes, 0);
});

test('only literal true gates pass and asynchronous final guards are rejected', async () => {
  for (const overrides of [{ preconditions: async () => 1 }, { authorize: async () => 'yes' },
    { validateCurrent: () => Promise.resolve(true) }]) {
    const registry = new AsyncCapabilityRegistry([capability({ ...overrides, run: () => assert.fail('must not run') })]);
    await assert.rejects(registry.invoke('write', {}));
  }
});

test('abort during preconditions prevents execution', async () => {
  const controller = new AbortController();
  const registry = new AsyncCapabilityRegistry([capability({
    preconditions: async () => { controller.abort(); return true; }, run: () => assert.fail('must not run')
  })]);
  await assert.rejects(registry.invoke('write', {}, { signal: controller.signal }), { name: 'AbortError' });
});

test('abort does not settle outstanding work early or discard uncertain termination errors', async () => {
  const controller = new AbortController();
  let rejectWork, started;
  const entered = new Promise(resolve => { started = resolve; });
  const registry = new AsyncCapabilityRegistry([capability({ run: () => {
    started(); return new Promise((_, reject) => { rejectWork = reject; });
  } })]);
  let settled = false;
  const pending = registry.invoke('write', {}, { signal: controller.signal });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await entered; controller.abort(); await Promise.resolve();
  assert.equal(settled, false);
  const failure = Object.assign(new Error('termination unknown'), { executionMayContinue: true });
  rejectWork(failure);
  await assert.rejects(pending, error => error === failure && error.executionMayContinue === true);
});
