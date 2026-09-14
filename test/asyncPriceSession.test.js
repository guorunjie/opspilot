import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { openAsyncPriceSession } from '../src/demo/asyncPriceSession.js';
const products = [{ id: 'A', name: 'Synthetic A', price: 2000, target: 1800, cost: 1000, stock: 12 }];
test('reservation failure follows durable START and cannot write or retry', async () => {
  const store = openStateStore(':memory:', 'reservation-failure');
  const wrapped = { read: store.read, save(key, value, revision) {
    if (key === 'async-price:one' && value.scenario !== null) {
      assert.equal(store.read('task:one').value.task.status, 'EXECUTING');
      throw new Error('reservation storage failure');
    }
    return store.save(key, value, revision);
  } };
  try {
    const session = openAsyncPriceSession({ store: wrapped, sessionId: 'one', products, create: true });
    await prepare(session);
    await assert.rejects(session.execute(), /reservation storage failure/);
    await session.whenIdle();
    assert.equal(session.snapshot().task.status, 'EXECUTING');
    assert.equal(session.snapshot().platform.submissionCount, 0);
    await assert.rejects(session.execute());
    const reopened = openAsyncPriceSession({ store, sessionId: 'one', products });
    await reopened.recover({ previousExecutorStopped: true });
    await reopened.readback();
    assert.equal(reopened.snapshot().task.status, 'FAILED');
    assert.equal(reopened.snapshot().platform.submissionCount, 0);
  } finally { store.close(); }
});
async function prepare(session) {
  await session.check(); const { task } = await session.preview();
  await session.confirm({ planId: task.plan.id, confirmed: true });
}
for (const scenario of ['normal', 'response_lost', 'mismatch', 'readback_unavailable']) {
  test(`async price session durably resumes separate readback: ${scenario}`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'opspilot-price-session-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'state.sqlite');
    let store = openStateStore(file, 'isolated-test');
    try {
      let session = openAsyncPriceSession({ store, sessionId: 'one', products, create: true });
      await assert.rejects(session.execute());
      await prepare(session); await session.execute({ scenario });
      assert.equal(session.snapshot().task.status, scenario === 'response_lost' ? 'UNKNOWN' : 'SUBMITTED');
      assert.equal(session.snapshot().task.verifications.length, 0);
      await session.whenIdle(); store.close(); store = openStateStore(file, 'isolated-test');
      session = openAsyncPriceSession({ store, sessionId: 'one', products });
      await assert.rejects(session.execute());
      await session.readback();
      if (scenario === 'readback_unavailable') {
        assert.equal(session.snapshot().task.status, 'UNKNOWN');
        await session.readback();
      }
      assert.equal(session.snapshot().task.status, scenario === 'mismatch' ? 'FAILED' : 'VERIFIED');
      assert.equal(session.snapshot().platform.submissionCount, 1);
    } finally { store.close(); }
  });
}

test('target write sees durable START; lost final checkpoint cannot repeat the write', async () => {
  const store = openStateStore(':memory:', 'isolated-test');
  let loseFinal = true;
  const wrapped = { read: key => store.read(key), save(key, value, revision) {
    if (key === 'async-price:one' && value.submissionCount === 1)
      assert.equal(store.read('task:one').value.task.status, 'EXECUTING');
    if (key === 'task:one' && value.task.status === 'SUBMITTED' && loseFinal)
      throw new Error('injected final checkpoint failure');
    return store.save(key, value, revision);
  } };
  try {
    const session = openAsyncPriceSession({ store: wrapped, sessionId: 'one', products, create: true });
    await prepare(session); await assert.rejects(session.execute(), /checkpoint failure/);
    assert.equal(store.read('task:one').value.task.status, 'EXECUTING');
    assert.equal(store.read('async-price:one').value.submissionCount, 1);
    loseFinal = false;
    const reopened = openAsyncPriceSession({ store, sessionId: 'one', products });
    await assert.rejects(reopened.execute());
    await assert.rejects(reopened.recover({ previousExecutorStopped: false }));
    await reopened.recover({ previousExecutorStopped: true });
    await reopened.readback();
    assert.equal(reopened.snapshot().task.status, 'VERIFIED');
    assert.equal(reopened.snapshot().platform.submissionCount, 1);
  } finally { store.close(); }
});

test('independent session handles cannot race to change execution scenario', async () => {
  const store = openStateStore(':memory:', 'isolated-test');
  try {
    const first = openAsyncPriceSession({ store, sessionId: 'one', products, create: true });
    const second = openAsyncPriceSession({ store, sessionId: 'one', products });
    await prepare(first);
    const execution = first.execute({ scenario: 'normal' });
    await assert.rejects(second.execute({ scenario: 'mismatch' }));
    await execution;
    assert.equal(first.snapshot().platform.scenario, 'normal');
    assert.equal(first.snapshot().platform.submissionCount, 1);
  } finally { store.close(); }
});

test('missing targets for an existing task are never recreated as initial prices', () => {
  const store = openStateStore(':memory:', 'isolated-test');
  try {
    openAsyncPriceSession({ store, sessionId: 'one', products, create: true });
    const missing = { read: key => key === 'async-price:one' ? null : store.read(key),
      save: () => assert.fail('must not recreate target state') };
    assert.throws(() => openAsyncPriceSession({ store: missing, sessionId: 'one', products, create: true }), /Target record missing/);
  } finally { store.close(); }
});
