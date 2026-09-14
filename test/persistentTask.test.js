import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { openPersistentTask } from '../src/storage/persistentTask.js';
import { advanceTask } from '../src/task/taskState.js';
import { createLocalTaskAgent } from '../src/agent/localTaskAgent.js';
const scope = { id: 'task', namespace: 'test', connectorId: 'mock', storeId: 'store' };
const fixture = run => {
  const root = mkdtempSync(path.join(tmpdir(), 'core-persistent-task-'));
  const file = path.join(root, 'tasks.sqlite');
  const a = openStateStore(file, 'tasks'); const b = openStateStore(file, 'tasks');
  try { run(a, b, file); } finally { a.close(); b.close(); rmSync(root, { recursive: true }); }
};
const append = (handle, event) => {
  const previous = handle.getTask(); const next = advanceTask(previous, event);
  handle.checkpoint(next, previous); return next;
};

test('explicit creation, detached reads, independent connection and reopen', () => fixture((a, b) => {
  assert.throws(() => openPersistentTask({ store: a, scope }), /explicit creation/);
  const first = openPersistentTask({ store: a, scope, create: true });
  const before = first.getTask(); before.status = 'VERIFIED';
  assert.equal(first.getTask().status, 'NOT_CHECKED');
  const checked = append(first, { type: 'CHECK', ready: true });
  assert.deepEqual(openPersistentTask({ store: b, scope }).getTask(), checked);
  assert.deepEqual(openPersistentTask({ store: b, scope, create: true }).getTask(), checked);
}));

test('rejects stale checkpoints, scope changes, skipped events and history replacement', () => fixture((a, b) => {
  const first = openPersistentTask({ store: a, scope, create: true });
  const second = openPersistentTask({ store: b, scope });
  const old = second.getTask();
  append(first, { type: 'CHECK', ready: true });
  assert.throws(() => second.checkpoint(advanceTask(old, { type: 'CHECK', ready: false }), old), /Stale/);
  const current = first.getTask();
  const planned = advanceTask(current, { type: 'PLAN', plan: { id: 'p', items: [{ targetId: 'A', before: 2, value: 1 }] } });
  const approved = advanceTask(planned, { type: 'APPROVE', planId: 'p', confirmed: true });
  assert.throws(() => first.checkpoint(approved, current), /exactly one/);
  const altered = { ...planned, storeId: 'another' };
  assert.throws(() => first.checkpoint(altered, current), /exactly one/);
  assert.throws(() => openPersistentTask({ store: b, scope: { ...scope, storeId: 'other' } }), /scope/);
  assert.deepEqual(first.getTask(), current);
}));

test('corrupt records are rejected without overwrite even with create enabled', () => fixture((a) => {
  openPersistentTask({ store: a, scope, create: true });
  const record = a.read('task:task'); record.value.task.status = 'VERIFIED';
  a.save('task:task', record.value, record.revision);
  const corrupt = a.read('task:task');
  assert.throws(() => openPersistentTask({ store: a, scope, create: true }));
  assert.deepEqual(a.read('task:task'), corrupt);
}));

test('atomic revision conflict between read and save cannot overwrite winning transition', () => fixture((a, b) => {
  const winner = openPersistentTask({ store: b, scope, create: true });
  const racing = openPersistentTask({ scope, store: { read: a.read, save(...args) {
    append(winner, { type: 'CHECK', ready: false }); return a.save(...args);
  } } });
  const previous = racing.getTask();
  assert.throws(() => racing.checkpoint(advanceTask(previous, { type: 'CHECK', ready: true }), previous), /revision conflict/);
  assert.throws(() => racing.getTask(), /uncertain/);
  assert.equal(winner.getTask().status, 'MISSING_DATA');
}));

test('Agent START is externally durable before write; lost checkpoint acknowledgement never writes', () => fixture((a, b) => {
  let writes = 0; let failAck = false;
  const store = { read: a.read, save(...args) {
    const revision = a.save(...args);
    if (failAck && args[1].task.status === 'EXECUTING') throw new Error('ack lost');
    return revision;
  } };
  const handle = openPersistentTask({ store, scope, create: true });
  const observer = openPersistentTask({ store: b, scope });
  const gateway = { get: id => ({ riskLevel: id === 'write' ? 'simulated_write' : 'readonly' }), invoke(id, request) {
    const saved = observer.getTask();
    if (id === 'write') {
      assert.equal(saved.status, 'EXECUTING'); writes++; return { status: 'SUBMITTED' };
    }
    assert.equal(saved.status, 'VERIFYING');
    return { planId: request.planId, connectorId: 'mock', storeId: 'store', items: [{ targetId: 'A', value: 2 }] };
  } };
  const config = { ...handle, planner: { proposePlan: () => ({ items: [{ targetId: 'A', before: 2, value: 1 }] }) }, gateway, writeCapabilityId: 'write', readCapabilityId: 'read' };
  const agent = createLocalTaskAgent(config);
  agent.check(true); agent.propose({ input: {}, planId: 'p' }); agent.approve({ planId: 'p', confirmed: true });
  failAck = true;
  assert.throws(() => agent.execute({ runId: 'r' }), /ack lost/);
  assert.equal(writes, 0); assert.equal(observer.getTask().status, 'EXECUTING');
  const reopened = createLocalTaskAgent({ ...config, ...openPersistentTask({ store: b, scope }) });
  assert.equal(reopened.recover().status, 'UNKNOWN');
  assert.throws(() => reopened.execute({ runId: 'again' }));
  assert.equal(reopened.verify().task.status, 'FAILED');
  assert.equal(writes, 0);
}));

test('normal Agent write and independent readback use persisted checkpoints', () => fixture((a, b) => {
  const handle = openPersistentTask({ store: a, scope, create: true });
  const observer = openPersistentTask({ store: b, scope }); let writes = 0;
  const agent = createLocalTaskAgent({ ...handle, planner: { proposePlan: () => ({ items: [{ targetId: 'A', before: 2, value: 1 }] }) },
    gateway: { get: id => ({ riskLevel: id === 'w' ? 'simulated_write' : 'readonly' }), invoke(id, request) {
      if (id === 'w') { assert.equal(observer.getTask().status, 'EXECUTING'); writes++; return { status: 'SUBMITTED' }; }
      assert.equal(observer.getTask().status, 'VERIFYING');
      return { ...request, connectorId: 'mock', items: [{ targetId: 'A', value: 1 }] };
    } }, writeCapabilityId: 'w', readCapabilityId: 'r' });
  agent.check(true); agent.propose({ input: {}, planId: 'p' }); agent.approve({ planId: 'p', confirmed: true });
  assert.equal(agent.execute({ runId: 'run' }).task.status, 'SUBMITTED');
  assert.equal(agent.verify().task.status, 'VERIFIED'); assert.equal(writes, 1);
  assert.deepEqual(observer.getTask(), agent.snapshot());
}));
