import test from 'node:test';
import assert from 'node:assert/strict';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { createTaskOwnership } from '../src/storage/taskOwnership.js';
import { createAsyncStoreDemo } from '../src/demo/asyncStoreDemo.js';
import { createDesktopDemo } from '../src/demo/desktopDemoFactory.js';
import { randomUUID } from 'node:crypto';
const call = async (demo, method, input) => {
  try { return await demo[method](input); } finally { await demo.whenIdle(); }
};

test('desktop composition binds shell, price and reset claims to trusted executor without exposing it', async () => {
  const store = openStateStore(':memory:', 'bound-composition');
  const executor = { pid: process.pid, hostId: randomUUID(), instanceId: randomUUID() };
  const expected = structuredClone(executor), claims = [];
  const wrapped = { read: store.read, save(key, value, revision) {
    if (key.startsWith('owner:') && value.token) {
      assert.equal(value.version, 2);
      assert.deepEqual(value.executor, expected);
      claims.push(key);
    }
    return store.save(key, value, revision);
  } };
  try {
    const demo = createDesktopDemo({ store: wrapped, executor });
    executor.pid = 1;
    await call(demo, 'diagnose');
    const plan = await call(demo, 'preview');
    await call(demo, 'confirm', { previewId: plan.id, confirmed: true });
    await call(demo, 'execute'); await call(demo, 'readback');
    const oldId = demo.snapshot().sessionId;
    assert.ok(claims.includes('owner:async-demo-shell'));
    assert.ok(claims.includes(`owner:${oldId}`));
    assert.equal(JSON.stringify(demo.snapshot()).includes(expected.instanceId), false);
    await call(demo, 'reset', { confirmed: true });
    await call(demo, 'diagnose');
    assert.ok(claims.includes(`owner:${demo.snapshot().sessionId}`));
  } finally { store.close(); }
});

test('composed async Demo preserves all three flows, reopens and explicitly resets', async () => {
  const store = openStateStore(':memory:', 'composed-demo');
  try {
    const demo = createAsyncStoreDemo({ store });
    await call(demo, 'diagnose');
    const plan = await call(demo, 'preview');
    await call(demo, 'confirm', { previewId: plan.id, confirmed: true });
    await call(demo, 'execute', { scenario: 'normal' });
    assert.equal(demo.snapshot().review, null);
    await call(demo, 'readback');
    for (const kind of ['inventory', 'campaign']) {
      await call(demo, 'opportunity', { kind, operation: 'preview' });
      const planId = demo.snapshot().supplemental[kind].task.plan.id;
      await call(demo, 'opportunity', { kind, operation: 'confirm', planId, confirmed: true });
      await call(demo, 'opportunity', { kind, operation: 'execute' });
      await call(demo, 'opportunity', { kind, operation: 'readback' });
      assert.equal(demo.snapshot().supplemental[kind].task.status, 'VERIFIED');
    }
    const before = demo.snapshot();
    assert.deepEqual(createAsyncStoreDemo({ store }).snapshot(), before);
    await assert.rejects(call(demo, 'reset', { confirmed: false }));
    assert.deepEqual(demo.snapshot(), before);
    await call(demo, 'reset', { confirmed: true });
    assert.notEqual(demo.snapshot().sessionId, before.sessionId);
    assert.equal(demo.snapshot().task.status, 'NOT_CHECKED');
    assert.deepEqual(demo.snapshot().supplemental, {});
    assert.equal(demo.snapshot().submissionCount, 0);
    assert.equal(store.read(`task:${before.sessionId}`).value.task.status, 'VERIFIED');
    assert.equal(store.read('pharmacy-session'), null);
  } finally { store.close(); }
});

test('active price ownership blocks reset and stale handles cannot mutate a new session', async () => {
  const store = openStateStore(':memory:', 'composed-demo');
  try {
    const demo = createAsyncStoreDemo({ store });
    const oldHandle = createAsyncStoreDemo({ store });
    const task = demo.snapshot().task;
    const owner = createTaskOwnership({ store, scope: task });
    const token = owner.acquire(task);
    await assert.rejects(call(demo, 'reset', { confirmed: true }), /owned/);
    assert.equal(demo.snapshot().sessionId, task.id);
    owner.release(token);
    await call(demo, 'reset', { confirmed: true });
    await assert.rejects(call(oldHandle, 'diagnose'), /session changed/);
    assert.equal(demo.snapshot().task.status, 'NOT_CHECKED');
  } finally { store.close(); }
});
