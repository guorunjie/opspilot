// test/compensationPersistence.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTask, advanceTask } from '../src/task/taskState.js';
import { prepareCompensationPreview } from '../src/task/compensationPreview.js';
import { openPersistentTask } from '../src/storage/persistentTask.js';
import { openStateStore } from '../src/storage/sqliteStateStore.js';

const AT = '2026-09-16T00:00:00.000Z';

const manifest = {
  schemaVersion: 1,
  id: 'example',
  label: 'Example',
  version: '0.1.0',
  platformIds: ['p'],
  requiredConfigKeys: [],
  capabilities: [
    {
      id: 'undo',
      label: 'Undo',
      operation: 'compensate',
      execution: 'host',
      simulated: false,
    },
  ],
};

const readback = {
  planId: 'p1',
  connectorId: 'example',
  storeId: 's',
  items: [{ targetId: 'x', value: 90 }],
};

function originalFixture() {
  let task = createTask({
    id: 'original',
    namespace: 'test',
    connectorId: 'example',
    storeId: 's',
  });
  task = advanceTask(task, { type: 'CHECK', at: AT, ready: true });
  task = advanceTask(task, {
    type: 'PLAN',
    at: AT,
    plan: { id: 'p1', items: [{ targetId: 'x', before: 100, value: 90 }] },
  });
  task = advanceTask(task, { type: 'APPROVE', at: AT, confirmed: true, planId: 'p1' });
  task = advanceTask(task, { type: 'START', at: AT, runId: 'r1' });
  task = advanceTask(task, { type: 'SUBMIT', at: AT, uncertain: true });
  return task;
}

function previewFor(original) {
  return prepareCompensationPreview({
    originalTask: original,
    manifest,
    capabilityId: 'undo',
    taskId: 'undo-task',
    planId: 'undo-plan',
    at: AT,
    readback,
  });
}

function makeTempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'opspilot-compensation-'));
}

function cleanup(root) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('opspilot-compensation-')) {
    rmSync(resolved, { recursive: true, force: true });
  }
}

function persistPreview(handle, preview) {
  for (const event of preview.task.history) {
    const previous = handle.getTask();
    const next = advanceTask(previous, event);
    handle.checkpoint(next, previous);
  }
  return handle.getTask();
}

test('durable compensation linkage survives reopen and requires separate approval', () => {
  const root = makeTempRoot();
  const file = path.join(root, 'tasks.sqlite');
  let store;

  try {
    const original = originalFixture();
    const preview = previewFor(original);

    store = openStateStore(file, 'tasks');
    const handle = openPersistentTask({ store, scope: preview.task, create: true });
    const persisted = persistPreview(handle, preview);

    assert.deepEqual(persisted.plan.compensationLink, preview.link);
    assert.equal(persisted.approval ?? null, null);
    assert.equal(persisted.run ?? null, null);

    assert.throws(() =>
      advanceTask(persisted, { type: 'START', at: AT, runId: 'undo-run' }),
    );
    assert.throws(() =>
      advanceTask(persisted, {
        type: 'APPROVE',
        at: AT,
        confirmed: true,
        planId: 'p1',
      }),
    );

    store.close();
    store = openStateStore(file, 'tasks');

    const reopenedHandle = openPersistentTask({ store, scope: preview.task });
    assert.deepEqual(reopenedHandle.getTask().plan.compensationLink, preview.link);

    let task = reopenedHandle.getTask();
    let previous = task;
    task = advanceTask(task, {
      type: 'APPROVE',
      at: AT,
      confirmed: true,
      planId: 'undo-plan',
    });
    reopenedHandle.checkpoint(task, previous);

    previous = task;
    task = advanceTask(task, { type: 'START', at: AT, runId: 'undo-run' });
    reopenedHandle.checkpoint(task, previous);

    previous = task;
    task = advanceTask(task, { type: 'INTERRUPT', at: AT });
    reopenedHandle.checkpoint(task, previous);
    assert.equal(task.status, 'UNKNOWN');

    store.close();
    store = openStateStore(file, 'tasks');

    const finalHandle = openPersistentTask({ store, scope: preview.task });
    const finalTask = finalHandle.getTask();
    assert.deepEqual(finalTask.plan.compensationLink, preview.link);
    assert.equal(finalTask.status, 'UNKNOWN');
    assert.equal(finalTask.run.id, 'undo-run');
    assert.throws(() =>
      advanceTask(finalTask, { type: 'START', at: AT, runId: 'undo-run-2' }),
    );
  } finally {
    try {
      store?.close();
    } catch {}
    cleanup(root);
  }
});

test('tampered persisted compensationLink without matching history is rejected', () => {
  const root = makeTempRoot();
  const file = path.join(root, 'tasks.sqlite');
  let store;

  try {
    const original = originalFixture();
    const preview = previewFor(original);

    store = openStateStore(file, 'tasks');
    const handle = openPersistentTask({ store, scope: preview.task, create: true });
    const persisted = persistPreview(handle, preview);

    const tampered = structuredClone(persisted);
    tampered.plan.compensationLink.compensationTaskId = 'other-task';
    const key = `task:${preview.task.id}`;
    const record = store.read(key);
    store.save(key, { ...record.value, task: tampered }, record.revision);

    store.close();
    store = openStateStore(file, 'tasks');

    assert.throws(() => {
      const reopened = openPersistentTask({ store, scope: preview.task });
      reopened.getTask();
    });
  } finally {
    try {
      store?.close();
    } catch {}
    cleanup(root);
  }
});
