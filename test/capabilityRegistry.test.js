import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/capability/capabilityRegistry.js';

test('registry has no production defaults and rejects duplicates or incomplete declarations', () => {
  const registry = new CapabilityRegistry();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get('missing'), null);
  assert.throws(() => registry.invoke('missing', {}));
  const capability = { id: 'mock.write', riskLevel: 'simulated_write', preconditions: () => true,
    authorize: () => true, run: () => ({ status: 'SUBMITTED' }) };
  registry.register(capability);
  assert.throws(() => registry.register(capability));
  assert.throws(() => new CapabilityRegistry([{ ...capability, authorize: null }]));
  assert.throws(() => new CapabilityRegistry([{ ...capability, preconditions: null }]));
  assert.throws(() => new CapabilityRegistry([{ ...capability, run: async () => true }]));
  capability.riskLevel = 'readonly';
  registry.get('mock.write').riskLevel = 'readonly';
  assert.equal(registry.get('mock.write').riskLevel, 'simulated_write');
});

test('preconditions and explicit authorizer precede execution; no implicit truthiness', () => {
  for (const decision of [false, undefined, {}, 'yes', Promise.resolve(true)]) {
    let calls = 0;
    const registry = new CapabilityRegistry([{ id: 'write', riskLevel: 'simulated_write',
      preconditions: () => true, authorize: () => decision, run: () => { calls++; } }]);
    assert.throws(() => registry.invoke('write', {}, { approvalConfirmed: true }));
    assert.equal(calls, 0);
  }
  const calls = [];
  const registry = new CapabilityRegistry([{ id: 'write', riskLevel: 'simulated_write',
    preconditions: () => { calls.push('check'); return false; },
    authorize: () => { calls.push('approve'); return true; }, run: () => calls.push('run') }]);
  assert.throws(() => registry.invoke('write', {}));
  assert.deepEqual(calls, ['check']);
});

test('real writes cannot be enabled with caller-supplied flags', () => {
  let invoked = false;
  const registry = new CapabilityRegistry([{ id: 'real', riskLevel: 'real_write',
    preconditions: () => true, authorize: () => true, run: () => { invoked = true; } }]);
  assert.throws(() => registry.invoke('real', {}, { allowLive: true, approved: true }), /disabled/);
  assert.equal(invoked, false);
});

test('stages receive independent data; returned submission never becomes VERIFIED', () => {
  const input = { value: 18 };
  const context = { planId: 'p1' };
  const registry = new CapabilityRegistry([{ id: 'write', riskLevel: 'simulated_write',
    preconditions: data => { data.value = 0; return true; },
    authorize: (data, ctx) => { assert.equal(data.value, 18); ctx.planId = 'other'; return true; },
    run: (data, ctx) => ({ status: 'SUBMITTED', ...data, ...ctx }) }]);
  assert.deepEqual(registry.invoke('write', input, context), { status: 'SUBMITTED', value: 18, planId: 'p1' });
  assert.deepEqual(input, { value: 18 });
  assert.deepEqual(context, { planId: 'p1' });
});
