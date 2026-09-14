import test from 'node:test';
import assert from 'node:assert/strict';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { openPersistentTask } from '../src/storage/persistentTask.js';
import { createTaskOwnership } from '../src/storage/taskOwnership.js';
import { createAsyncTaskAgent } from '../src/agent/asyncTaskAgent.js';
import { advanceTask } from '../src/task/taskState.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const scope = { id: 'task', namespace: 'test', connectorId: 'mock', storeId: 'store' };
function fixture(t, options = {}) {
  const store = openStateStore(':memory:', 'async-tests'); t.after(() => store.close());
  const handle = openPersistentTask({ store, scope, create: true }); let writes = 0;
  const config = { ...handle, ownership: createTaskOwnership({ store, scope }), timeoutMs: 1000, planner: { proposePlan: async () => ({ items: [{ targetId: 'A', before: 2, value: 1 }] }) },
    gateway: { get: id => ({ riskLevel: id === 'w' ? 'simulated_write' : 'readonly' }), async invoke(id, req, context) {
      if (id === 'w') { assert.equal(handle.getTask().status, 'EXECUTING'); writes++; return options.write ? options.write(req, context) : { status: 'SUBMITTED' }; }
      assert.equal(handle.getTask().status, 'VERIFYING');
      return options.read ? options.read(req, context) : { planId: req.planId, storeId: req.storeId, connectorId: 'mock', items: [{ targetId: 'A', value: 1 }] };
    } }, writeCapabilityId: 'w', readCapabilityId: 'r', ...options.config };
  const agent = createAsyncTaskAgent(config);
  const prepare = async () => { await agent.check(true); await agent.propose({ input: {}, planId: 'p' }); await agent.approve({ planId: 'p', confirmed: true }); };
  return { agent, prepare, config, handle, get writes() { return writes; } };
}
test('async submission and independent readback have separate persisted states', async t => {
  const f = fixture(t); await f.prepare();
  assert.equal((await f.agent.execute({ runId: 'run' })).task.status, 'SUBMITTED');
  assert.equal(f.agent.snapshot().verifications.length, 0);
  assert.equal((await f.agent.verify()).task.status, 'VERIFIED'); assert.equal(f.writes, 1);
  await assert.rejects(f.agent.execute({ runId: 'again' }));
});
test('pending async call rejects concurrent execution, approval, verification and recovery', async t => {
  const gate = deferred(); const f = fixture(t, { write: () => gate.promise }); await f.prepare();
  const execution = f.agent.execute({ runId: 'run' });
  await assert.rejects(f.agent.execute({ runId: 'again' }), /progress/);
  await assert.rejects(f.agent.verify(), /progress/);
  await assert.rejects(f.agent.recover({ previousExecutorStopped: true }), /progress/);
  assert.equal(f.agent.snapshot().status, 'EXECUTING');
  gate.resolve({ status: 'SUBMITTED' }); await execution; assert.equal(f.writes, 1);
});
test('timeout retains fence until actual settlement; late response cannot set success', async t => {
  const gate = deferred(); let signal;
  const f = fixture(t, { write: (_req, ctx) => { signal = ctx.signal; return gate.promise; }, config: { timeoutMs: 30 } });
  await f.prepare(); await assert.rejects(f.agent.execute({ runId: 'run' }), /timed out/);
  assert.equal(signal.aborted, true); assert.equal(f.agent.snapshot().status, 'UNKNOWN');
  await assert.rejects(f.agent.verify(), /progress/);
  gate.resolve({ status: 'VERIFIED' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.agent.snapshot().status, 'UNKNOWN');
  await assert.rejects(f.agent.execute({ runId: 'again' }));
  assert.equal((await f.agent.verify()).task.status, 'VERIFIED'); assert.equal(f.writes, 1);
});
test('write rejection stays UNKNOWN and only a fresh independent readback verifies', async t => {
  const f = fixture(t, { write: async () => { throw new Error('response lost'); } }); await f.prepare();
  await assert.rejects(f.agent.execute({ runId: 'run' }), /response lost/);
  assert.equal(f.agent.snapshot().status, 'UNKNOWN');
  assert.equal((await f.agent.verify()).task.status, 'VERIFIED');
});
test('stale async plan cannot replace externally changed task', async t => {
  const gate = deferred(); const f = fixture(t, { config: { planner: { proposePlan: () => gate.promise } } });
  await f.agent.check(true); const proposed = f.agent.propose({ input: {}, planId: 'p' });
  const previous = f.handle.getTask(); f.handle.checkpoint(advanceTask(previous, { type: 'CHECK', ready: false }), previous);
  gate.resolve({ items: [{ targetId: 'A', before: 2, value: 1 }] });
  await assert.rejects(proposed, /changed/); assert.equal(f.agent.snapshot().status, 'MISSING_DATA');
});
test('recovery requires executor termination assertion and never writes', async t => {
  const f = fixture(t); await f.prepare(); const previous = f.handle.getTask();
  f.handle.checkpoint(advanceTask(previous, { type: 'START', runId: 'interrupted' }), previous);
  await assert.rejects(f.agent.recover(), /termination/);
  assert.equal((await f.agent.recover({ previousExecutorStopped: true })).status, 'UNKNOWN');
  await assert.rejects(f.agent.execute({ runId: 'again' })); assert.equal(f.writes, 0);
});
test('real-write metadata and non-boolean approval fail before invocation', async t => {
  const f = fixture(t, { config: { gateway: { get: () => ({ riskLevel: 'real_write' }), invoke: () => { throw new Error('must not invoke'); } } } });
  await f.agent.check(true); await f.agent.propose({ input: {}, planId: 'p' });
  await assert.rejects(f.agent.approve({ planId: 'p', confirmed: 'yes' }));
  await assert.rejects(f.agent.execute({ runId: 'run' }), /role/); assert.equal(f.agent.snapshot().run, null);
});

test('read timeout and late rejection preserve UNKNOWN without unhandled rejection', async t => {
  const gate = deferred(); let reads = 0;
  const f = fixture(t, { read: req => ++reads === 1 ? gate.promise : { ...req, connectorId: 'mock', items: [{ targetId: 'A', value: 1 }] }, config: { timeoutMs: 30 } });
  await f.prepare(); await f.agent.execute({ runId: 'run' });
  await assert.rejects(f.agent.verify(), /timed out/);
  assert.equal(f.agent.snapshot().status, 'UNKNOWN'); assert.equal(f.agent.snapshot().verifications.length, 0);
  gate.reject(new Error('late disconnect')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.agent.snapshot().status, 'UNKNOWN');
  assert.equal((await f.agent.verify()).task.status, 'VERIFIED'); assert.equal(f.writes, 1);
});

test('failed START checkpoint prevents invoking connector and poisons instance', async t => {
  const f = fixture(t); await f.prepare();
  const agent = createAsyncTaskAgent({ ...f.config, checkpoint() { throw new Error('disk unavailable'); } });
  await assert.rejects(agent.execute({ runId: 'run' }), /disk unavailable/);
  assert.equal(f.writes, 0); assert.equal(f.handle.getTask().run, null);
  await assert.rejects(agent.execute({ runId: 'again' }), /uncertain/);
});

test('planner receives detached input; generated authorization and identity are inert', async t => {
  const f = fixture(t, { config: { planner: { async proposePlan(input, ctx) {
    input.changed = true; ctx.task.storeId = 'wrong';
    return { items: [{ targetId: 'A', before: 2, value: 1 }], approval: true, status: 'VERIFIED', id: 'wrong', capabilityId: 'real' };
  } } } });
  const input = {}; await f.agent.check(true); await f.agent.propose({ input, planId: 'p' });
  assert.deepEqual(input, {}); assert.equal(f.agent.snapshot().storeId, 'store');
  assert.equal(f.agent.snapshot().plan.id, 'p'); assert.equal(f.agent.snapshot().approval, null);
  await assert.rejects(f.agent.execute({ runId: 'run' })); assert.equal(f.writes, 0);
});

test('second Agent cannot recover or verify until timed-out original promise actually settles', async t => {
  const gate = deferred(); const f = fixture(t, { write: () => gate.promise, config: { timeoutMs: 30 } });
  await f.prepare(); const second = createAsyncTaskAgent(f.config);
  await assert.rejects(f.agent.execute({ runId: 'run' }), /timed out/);
  assert.ok(f.config.ownership.inspect().token);
  await assert.rejects(second.verify(), /owned/);
  await assert.rejects(second.recover({ previousExecutorStopped: true }), /owned/);
  gate.resolve({ status: 'SUBMITTED' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.config.ownership.inspect().token, null);
  assert.equal((await second.verify()).task.status, 'VERIFIED'); assert.equal(f.writes, 1);
});

test('release acknowledgement failure stops the Agent instead of reporting clean completion', async t => {
  const f = fixture(t); const base = f.config.ownership;
  const agent = createAsyncTaskAgent({ ...f.config, ownership: { ...base, release(token) {
    base.release(token); throw new Error('release ack lost');
  } } });
  await assert.rejects(agent.check(true), /release uncertain/);
  assert.equal(f.handle.getTask().status, 'READY');
  await assert.rejects(agent.check(true), /uncertain/);
});

test('whenIdle waits for late settlement and ownership release', async t => {
  const gate = deferred(); const f = fixture(t, { write: () => gate.promise, config: { timeoutMs: 30 } });
  await f.prepare(); await assert.rejects(f.agent.execute({ runId: 'run' }), /timed out/);
  let idle = false; const drained = f.agent.whenIdle().then(() => { idle = true; });
  assert.equal(idle, false); gate.resolve({ status: 'SUBMITTED' }); await drained;
  assert.equal(f.config.ownership.inspect().token, null); assert.equal(f.agent.snapshot().status, 'UNKNOWN');
});
test('unconfirmed external termination retains ownership even after rejection', async t => {
  const f = fixture(t, { write: async () => { throw Object.assign(new Error('close failed'), { executionMayContinue: true }); } });
  await f.prepare(); await assert.rejects(f.agent.execute({ runId: 'run' }), /close failed/);
  assert.equal(f.agent.snapshot().status, 'UNKNOWN');
  assert.ok(f.config.ownership.inspect().token);
  await assert.rejects(f.agent.whenIdle(), /termination unconfirmed/);
  await assert.rejects(createAsyncTaskAgent(f.config).verify(), /owned/);
});
