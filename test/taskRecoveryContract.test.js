import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, advanceTask, assertTask, TASK_STATES } from '../src/task/taskState.js';

function executing() {
  let task = createTask({ id: 'task', namespace: 'demo', connectorId: 'mock', storeId: 'store' });
  for (const event of [{ type: 'CHECK', ready: true },
    { type: 'PLAN', plan: { id: 'plan', items: [{ targetId: 'sku', before: 20, value: 18 }] } },
    { type: 'APPROVE', planId: 'plan', confirmed: true }, { type: 'START', runId: 'run' }]) task = advanceTask(task, event);
  return task;
}
const readback = value => ({ planId: 'plan', connectorId: 'mock', storeId: 'store', items: [{ targetId: 'sku', value }] });

test('interrupted execution or verification persists UNKNOWN and forbids another run', () => {
  for (const verifying of [false, true]) {
    let task = executing();
    if (verifying) {
      task = advanceTask(task, { type: 'SUBMIT', uncertain: false });
      task = advanceTask(task, { type: 'BEGIN_VERIFY' });
    }
    task = advanceTask(task, { type: 'INTERRUPT' });
    task = JSON.parse(JSON.stringify(task));
    assertTask(task);
    assert.equal(task.status, 'UNKNOWN');
    assert.throws(() => advanceTask(task, { type: 'START', runId: 'another' }));
    task = advanceTask(task, { type: 'BEGIN_VERIFY' });
    task = advanceTask(task, { type: 'READBACK', readback: readback(18) });
    assert.equal(task.status, 'VERIFIED');
  }
});

test('rollback result contract requires confirmation and exact original target readback', () => {
  let task = advanceTask(executing(), { type: 'SUBMIT', uncertain: true });
  assert.throws(() => advanceTask(task, { type: 'ROLLBACK_READBACK', planId: 'plan', readback: readback(20) }));
  assert.throws(() => advanceTask(task, { type: 'ROLLBACK_READBACK', planId: 'other', confirmed: true, readback: readback(20) }));
  for (const value of [null, 18, 20]) {
    const result = advanceTask(task, { type: 'ROLLBACK_READBACK', planId: 'plan', confirmed: true, readback: readback(value) });
    assert.equal(result.status, value === 20 ? 'ROLLED_BACK' : 'UNKNOWN');
    assertTask(JSON.parse(JSON.stringify(result)));
    assert.throws(() => advanceTask(result, { type: 'START', runId: 'again' }));
    assert.throws(() => advanceTask(result, { type: 'BEGIN_VERIFY' }));
  }
});

test('state vocabulary is complete and no arbitrary status event is accepted', () => {
  assert.deepEqual([...TASK_STATES].sort(), ['NOT_CHECKED', 'MISSING_DATA', 'READY', 'AWAITING_APPROVAL',
    'EXECUTING', 'SUBMITTED', 'VERIFYING', 'VERIFIED', 'PARTIALLY_VERIFIED', 'FAILED', 'ROLLED_BACK', 'UNKNOWN'].sort());
  assert.throws(() => advanceTask(executing(), { type: 'SET_STATUS', status: 'VERIFIED' }));
  assert.throws(() => advanceTask(executing(), { type: 'READBACK', readback: readback(18) }));
});
