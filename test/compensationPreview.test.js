import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCompensationPreview } from '../src/task/compensationPreview.js';
import { createTask, advanceTask } from '../src/task/taskState.js';

const AT = '2026-09-16T00:00:00.000Z';
const at = AT;

const manifest = {
  schemaVersion: 1,
  id: 'example',
  label: 'Example',
  version: '0.1.0',
  platformIds: ['p'],
  requiredConfigKeys: [],
  capabilities: [
    { id: 'undo', label: 'Undo', operation: 'compensate', execution: 'host', simulated: false },
  ],
};

const readback = {
  planId: 'p1',
  connectorId: 'example',
  storeId: 's',
  items: [{ targetId: 'x', value: 90 }],
};

function submitted() {
  let t = createTask({ id: 'original', namespace: 'test', connectorId: 'example', storeId: 's' });
  t = advanceTask(t, { type: 'CHECK', ready: true, at });
  t = advanceTask(t, { type: 'PLAN', plan: { id: 'p1', items: [{ targetId: 'x', before: 100, value: 90 }] }, at });
  t = advanceTask(t, { type: 'APPROVE', confirmed: true, planId: 'p1', at });
  t = advanceTask(t, { type: 'START', runId: 'r1', at });
  t = advanceTask(t, { type: 'SUBMIT', uncertain: true, at });
  return t;
}

function call(t, over = {}) {
  return prepareCompensationPreview({
    originalTask: t,
    manifest,
    capabilityId: 'undo',
    readback,
    taskId: 'undo-task',
    planId: 'undo-plan',
    at,
    ...over,
  });
}

const frozen = JSON.stringify(submitted());

test('preview builds a separate-approval compensation task from exact current state', () => {
  const t = submitted();
  assert.equal(t.status, 'UNKNOWN');
  const r = call(t);
  assert.equal(r.status, 'AWAITING_APPROVAL');
  assert.equal(r.reason, 'separate_approval_required');
  assert.equal(r.task.status, 'AWAITING_APPROVAL');
  assert.equal(r.task.plan.id, 'undo-plan');
  assert.ok(Object.isFrozen(r.task.plan.items[0]));
  assert.ok(Object.isFrozen(r.link));
  assert.deepEqual(r.task.plan.items, [{ targetId: 'x', before: 90, value: 100 }]);
  assert.equal(r.task.approval, null);
  assert.equal(r.task.run, null);
  assert.deepEqual(r.link, {
    originalTaskId: 'original',
    originalPlanId: 'p1',
    compensationPlanId: 'undo-plan',
    originalRunId: 'r1',
    compensationTaskId: 'undo-task',
    capabilityId: 'undo',
    execution: 'host',
    simulated: false,
  });
  assert.equal(r.task.approval, null);
});

test('preview never mutates the original task', () => {
  const t = submitted();
  call(t);
  assert.equal(JSON.stringify(t), frozen);
});

test('compensation task rejects START before separate APPROVE, then starts a distinct run', () => {
  const t = submitted();
  const preview = call(t);
  assert.throws(() => advanceTask(preview.task, { type: 'START', runId: 'r2', at }));
  const approved = advanceTask(preview.task, { type: 'APPROVE', confirmed: true, planId: 'undo-plan', at });
  const started = advanceTask(approved, { type: 'START', runId: 'r2', at });
  assert.equal(started.status, 'EXECUTING');
  assert.equal(started.run.id, 'r2');
});

test('no matching compensate capability is UNSUPPORTED', () => {
  const t = submitted();
  const noCap = { ...manifest, capabilities: [{ ...manifest.capabilities[0], operation: 'read' }] };
  assert.deepEqual(call(t, { manifest: noCap }), { status: 'UNSUPPORTED', reason: 'compensation_not_declared', task: null, link: null });
  assert.deepEqual(call(t, { capabilityId: 'missing' }), { status: 'UNSUPPORTED', reason: 'compensation_not_declared', task: null, link: null });
});

test('missing or inexact current readback is UNKNOWN', () => {
  const t = submitted();
  for (const bad of [
    call(t, { readback: { ...readback, items: [] } }),
    call(t, { readback: { ...readback, items: [{ targetId: 'x', value: 95 }] } }),
    call(t, { readback: { ...readback, storeId: 'other' } }),
    call(t, { readback: null }),
  ]) {
    assert.deepEqual(bad, { status: 'UNKNOWN', reason: 'current_state_not_exact', task: null, link: null });
  }
});

test('original still before START is UNKNOWN', () => {
  let t = createTask({ id: 'original', namespace: 'test', connectorId: 'example', storeId: 's' });
  t = advanceTask(t, { type: 'CHECK', ready: true, at });
  t = advanceTask(t, { type: 'PLAN', plan: { id: 'p1', items: [{ targetId: 'x', before: 100, value: 90 }] }, at });
  t = advanceTask(t, { type: 'APPROVE', confirmed: true, planId: 'p1', at });
  const r = call(t);
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.task, null);
  assert.equal(r.link, null);
});

test('duplicate ids and bad time throw', () => {
  const t = submitted();
  assert.throws(() => call(t, { taskId: 'original' }));
  assert.throws(() => call(t, { planId: 'p1' }));
  assert.throws(() => call(t, { at: 'not-a-time' }));
});

test('manifest connector mismatch throws', () => {
  const t = submitted();
  assert.throws(() => call(t, { manifest: { ...manifest, id: 'other' } }));
});

test('prior rollback observation makes preview UNKNOWN', () => {
  let t = submitted();
  t = advanceTask(t, {
    type: 'ROLLBACK_READBACK',
    confirmed: true,
    planId: 'p1',
    readback: { planId: 'p1', connectorId: 'example', storeId: 's' },
    at,
  });
  const r = call(t);
  assert.deepEqual(r, { status: 'UNKNOWN', reason: 'rollback_already_observed', task: null, link: null });
});
