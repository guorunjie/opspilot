import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateStore } from '../src/storage/sqliteStateStore.js';

test('SQLite snapshot survives reopening and stale writers cannot overwrite it', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'opspilot-core-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'demo.sqlite');
  let store = openStateStore(file, 'demo');
  assert.equal(store.read('session'), null);
  assert.equal(store.save('session', { status: 'SUBMITTED', submissionCount: 1 }, 0), 1);
  store.close();
  store = openStateStore(file, 'demo');
  const other = openStateStore(file, 'demo');
  try {
    assert.deepEqual(store.read('session'), { revision: 1, value: { status: 'SUBMITTED', submissionCount: 1 } });
    assert.equal(other.save('session', { status: 'VERIFYING' }, 1), 2);
    assert.throws(() => store.save('session', { status: 'READY' }, 1), /conflict/i);
    assert.deepEqual(store.read('session'), { revision: 2, value: { status: 'VERIFYING' } });
    assert.throws(() => store.save('session', {}, 0), /conflict/i);
  } finally { other.close(); store.close(); }
});

test('namespaces do not share snapshots and invalid revisions fail before writing', () => {
  const store = openStateStore(':memory:', 'demo');
  try {
    for (const revision of [-1, NaN, 1.5, '0']) assert.throws(() => store.save('task', {}, revision));
    assert.equal(store.read('task'), null);
    assert.throws(() => store.save('task', undefined, 0));
    assert.equal(store.read('task'), null);
  } finally { store.close(); }
});

test('two namespaces in one file remain distinct', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'opspilot-core-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.sqlite');
  const first = openStateStore(file, 'demo-a');
  const second = openStateStore(file, 'demo-b');
  try {
    first.save('task', { value: 1 }, 0);
    assert.equal(second.read('task'), null);
    second.save('task', { value: 2 }, 0);
    assert.equal(first.read('task').value.value, 1);
    assert.equal(second.read('task').value.value, 2);
  } finally { second.close(); first.close(); }
});
