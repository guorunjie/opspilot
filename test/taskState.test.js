// GPT fallback after DS-014 was explicitly cancelled without a draft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, advanceTask, assertTask } from '../src/task/taskState.js';
const fresh = () => createTask({ id: 't1', namespace: 'demo', connectorId: 'mock', storeId: 's1' });
const plan = (id = 'p1', items = [{ targetId: 'a', before: 20, value: 18 }]) => ({ id, items });
const event = (task, type, data = {}) => advanceTask(task, { type, ...data });
const ready = () => event(fresh(), 'CHECK', { ready: true });
const planned = () => event(ready(), 'PLAN', { plan: plan() });
const approved = () => event(planned(), 'APPROVE', { confirmed: true, planId: 'p1' });
const start = () => event(approved(), 'START', { runId: 'r1' });
const read = items => ({ planId: 'p1', connectorId: 'mock', storeId: 's1', items });

test('only scoped readback after submission and verification produces VERIFIED', () => {
  let task = event(start(), 'SUBMIT', { uncertain: false });
  assert.equal(task.status, 'SUBMITTED');
  assert.equal(task.verifications.length, 0);
  assert.throws(() => event(task, 'READBACK', { readback: read([{ targetId: 'a', value: 18 }]) }));
  task = event(task, 'BEGIN_VERIFY');
  task = event(task, 'READBACK', { readback: read([{ targetId: 'a', value: 18 }]) });
  assert.equal(task.status, 'VERIFIED');
  assertTask(JSON.parse(JSON.stringify(task)));
});

test('missing data blocks a plan until another trusted check supplies readiness', () => {
  let task = event(fresh(), 'CHECK', { ready: false });
  assert.equal(task.status, 'MISSING_DATA');
  assert.throws(() => event(task, 'PLAN', { plan: plan() }));
  assert.throws(() => event(task, 'CHECK', { ready: 'yes' }));
  task = event(task, 'CHECK', { ready: true });
  assert.equal(event(task, 'PLAN', { plan: plan() }).status, 'AWAITING_APPROVAL');
});

test('only explicit current approval can start; approved plan cannot change', () => {
  const task = planned();
  assert.throws(() => event(task, 'START', { runId: 'r1' }));
  for (const confirmed of [false, 'true', undefined]) {
    assert.throws(() => event(task, 'APPROVE', { planId: 'p1', confirmed }));
  }
  const changed = event(task, 'PLAN', { plan: plan('p2') });
  assert.throws(() => event(changed, 'APPROVE', { planId: 'p1', confirmed: true }));
  assert.throws(() => event(task, 'PLAN', { plan: plan() }), /reused/);
  assert.throws(() => event(approved(), 'PLAN', { plan: plan('p2') }));
  assert.throws(() => event(approved(), 'APPROVE', { planId: 'p1', confirmed: true }));
});

test('one task cannot start or submit twice, including after UNKNOWN', () => {
  const running = start();
  assert.throws(() => event(running, 'START', { runId: 'r2' }));
  const unknown = event(running, 'SUBMIT', { uncertain: true });
  assert.equal(unknown.status, 'UNKNOWN');
  assert.throws(() => event(unknown, 'SUBMIT', { uncertain: false }));
  assert.throws(() => event(unknown, 'START', { runId: 'r2' }));
  const unavailable = event(event(unknown, 'BEGIN_VERIFY'), 'READBACK', { readback: null });
  assert.equal(unavailable.status, 'UNKNOWN');
  const settled = event(event(unavailable, 'BEGIN_VERIFY'), 'READBACK', { readback: read([{ targetId: 'a', value: 18 }]) });
  assert.equal(settled.status, 'VERIFIED');
  assert.equal(settled.history.filter(e => e.type === 'START').length, 1);
});

test('two target results remain partial and retain item evidence', () => {
  let task = event(ready(), 'PLAN', { plan: plan('p1', [
    { targetId: 'a', before: 20, value: 18 }, { targetId: 'b', before: 30, value: 25 }]) });
  task = event(task, 'APPROVE', { confirmed: true, planId: 'p1' });
  task = event(task, 'START', { runId: 'r1' });
  task = event(task, 'SUBMIT', { uncertain: false });
  task = event(event(task, 'BEGIN_VERIFY'), 'READBACK', { readback: read([{ targetId: 'a', value: 18 }]) });
  assert.equal(task.status, 'PARTIALLY_VERIFIED');
  assert.deepEqual(task.verifications[0].items.map(item => item.status), ['VERIFIED', 'UNKNOWN']);
  assertTask(task);
});

test('replay rejects independently corrupted status, plan, approval and history', () => {
  for (const corrupt of [t => { t.status = 'VERIFIED'; }, t => { t.plan.items[0].value = 0; },
    t => { t.approval.planId = 'different'; }, t => { t.history.pop(); }]) {
    const task = approved(); corrupt(task); assert.throws(() => assertTask(task));
  }
});

test('events, returned records and earlier states never alias', () => {
  const before = ready();
  const input = { type: 'PLAN', plan: plan() };
  const after = advanceTask(before, input);
  input.plan.items[0].value = 0;
  assert.equal(after.plan.items[0].value, 18);
  after.plan.items[0].value = 1;
  assert.equal(after.history.at(-1).plan.items[0].value, 18);
  assert.equal(before.plan, null);
  assertTask(before);
});

test('invalid plans never pass readiness and malformed events do not mutate state', () => {
  for (const items of [[], new Array(1), [{ targetId: 'a', before: 20, value: null }],
    [{ targetId: 'a', before: -1, value: 18 }], [plan().items[0], plan().items[0]]]) {
    assert.throws(() => event(ready(), 'PLAN', { plan: plan('p1', items) }));
  }
  const task = ready(); const before = structuredClone(task);
  assert.throws(() => advanceTask(task, { type: 'PLAN', plan: plan(), at: 'invalid' }));
  assert.deepEqual(task, before);
});
