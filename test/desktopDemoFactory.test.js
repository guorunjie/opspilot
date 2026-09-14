import test from 'node:test';
import assert from 'node:assert/strict';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { createDesktopDemo } from '../src/demo/desktopDemoFactory.js';
import { createOfflineStoreDemo } from '../src/demo/offlineStoreDemo.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('fresh desktop uses async persistence and prevents silent downgrade', async () => {
  const store = openStateStore(':memory:', 'desktop');
  try {
    const demo = createDesktopDemo({ store });
    assert.equal(store.read('pharmacy-session').value.version, 4);
    assert.equal(typeof demo.whenIdle, 'function');
    await demo.diagnose(); await demo.whenIdle();
    assert.deepEqual(createDesktopDemo({ store }).snapshot(), demo.snapshot());
    assert.throws(() => createOfflineStoreDemo({ store }), /存档无效/);
  } finally { store.close(); }
});

test('existing legacy confirmation is preserved without async initialization', () => {
  const store = openStateStore(':memory:', 'desktop');
  try {
    const old = createOfflineStoreDemo({ store }); old.diagnose();
    const plan = old.preview(); old.confirm({ previewId: plan.id, confirmed: true });
    const row = store.read('pharmacy-session');
    const opened = createDesktopDemo({ store });
    const { legacyUpgrade, legacyArchive, ...rest } = opened.snapshot();
    assert.deepEqual(rest, old.snapshot());
    assert.deepEqual(legacyUpgrade, { available: true, revision: row.revision });
    assert.equal(legacyArchive, null);
    assert.deepEqual(store.read('pharmacy-session'), row);
    assert.equal(store.read('async-demo-active'), null);
    assert.equal(opened.snapshot().submissionCount, 0);
  } finally { store.close(); }
});

for (const phase of ['ready', 'approved', 'submitted', 'verified']) test(`explicit upgrade preserves ${phase} records without replaying old approval`, async () => {
  const store = openStateStore(':memory:', 'desktop');
  try {
    const old = createOfflineStoreDemo({ store }); old.diagnose();
    if (phase !== 'ready') { const p = old.preview(); old.confirm({ previewId: p.id, confirmed: true }); }
    if (['submitted', 'verified'].includes(phase)) old.execute();
    if (phase === 'verified') {
      old.readback();
      for (const kind of ['inventory', 'campaign']) {
        old.opportunity({ kind, operation: 'preview' });
        const planId = old.snapshot().supplemental[kind].task.plan.id;
        old.opportunity({ kind, operation: 'confirm', planId, confirmed: true });
        old.opportunity({ kind, operation: 'execute' }); old.opportunity({ kind, operation: 'readback' });
      }
    }
    const row = store.read('pharmacy-session'), snapshot = old.snapshot();
    const desktop = createDesktopDemo({ store });
    assert.throws(() => desktop.upgrade({ confirmed: false, expectedRevision: row.revision }), /明确确认/);
    assert.deepEqual(store.read('pharmacy-session'), row);
    const upgraded = desktop.upgrade({ confirmed: true, expectedRevision: row.revision });
    assert.deepEqual(store.read('pharmacy-session').value.legacyArchive, row);
    assert.deepEqual(upgraded.legacyArchive, snapshot);
    assert.equal(upgraded.legacyUpgrade, null);
    assert.equal(upgraded.diagnosis, null); assert.equal(upgraded.submissionCount, 0);
    assert.equal(upgraded.task.approval, null); assert.equal(upgraded.action, null);
    await assert.rejects(async () => desktop.confirm({ previewId: snapshot.preview?.id, confirmed: true }));
    assert.deepEqual(createDesktopDemo({ store }).snapshot(), desktop.snapshot());
    assert.throws(() => desktop.upgrade({ confirmed: true, expectedRevision: row.revision }), /已变化/);
    assert.throws(() => old.reset(), /revision conflict/);
    await desktop.reset({ confirmed: true }); await desktop.whenIdle();
    assert.deepEqual(desktop.snapshot().legacyArchive, snapshot);
    const copy = desktop.snapshot().legacyArchive; copy.message = 'tampered';
    assert.deepEqual(desktop.snapshot().legacyArchive, snapshot);
  } finally { store.close(); }
});

test('stale upgrade confirmation cannot archive a changed record', () => {
  const store = openStateStore(':memory:', 'desktop');
  try {
    const old = createOfflineStoreDemo({ store }); const desktop = createDesktopDemo({ store });
    const expectedRevision = desktop.snapshot().legacyUpgrade.revision;
    old.diagnose(); const changed = store.read('pharmacy-session');
    assert.throws(() => desktop.upgrade({ confirmed: true, expectedRevision }), /已变化/);
    assert.deepEqual(store.read('pharmacy-session'), changed);
    assert.equal(store.read('async-demo-active'), null);
  } finally { store.close(); }
});

test('v1 task-less records remain task-less in the archive, not inferred as verified', () => {
  const store = openStateStore(':memory:', 'desktop');
  try {
    createOfflineStoreDemo({ store }).diagnose();
    const row = store.read('pharmacy-session'); delete row.value.state.task; row.value.version = 1;
    store.save('pharmacy-session', row.value, row.revision);
    const before = store.read('pharmacy-session');
    const demo = createDesktopDemo({ store });
    const upgraded = demo.upgrade({ confirmed: true, expectedRevision: before.revision });
    assert.equal(Object.hasOwn(upgraded.legacyArchive, 'task'), false);
    assert.equal(upgraded.legacyArchive.review, null);
    assert.deepEqual(store.read('pharmacy-session').value.legacyArchive, before);
    assert.equal(upgraded.task.status, 'NOT_CHECKED');
  } finally { store.close(); }
});

for (const afterWrite of [false, true]) test(`upgrade acknowledgement loss afterWrite=${afterWrite} preserves complete old data`, () => {
  const store = openStateStore(':memory:', 'desktop');
  try {
    createOfflineStoreDemo({ store }).diagnose(); const row = store.read('pharmacy-session');
    const faulty = { read: key => store.read(key), save: (key, value, revision) => {
      if (afterWrite) store.save(key, value, revision);
      throw new Error('lost acknowledgement');
    } };
    const demo = createDesktopDemo({ store: faulty });
    assert.throws(() => demo.upgrade({ confirmed: true, expectedRevision: row.revision }), /lost acknowledgement/);
    assert.throws(() => demo.reset(), /保存结果不明/);
    if (afterWrite) {
      assert.deepEqual(store.read('pharmacy-session').value.legacyArchive, row);
      assert.equal(store.read('async-demo-active'), null);
      const reopened = createDesktopDemo({ store }).snapshot();
      assert.deepEqual(reopened.legacyArchive.diagnosis, row.value.state.diagnosis);
      assert.equal(reopened.submissionCount, 0);
    } else assert.deepEqual(store.read('pharmacy-session'), row);
  } finally { store.close(); }
});

test('corrupt embedded archive blocks opening before async initialization', () => {
  const store = openStateStore(':memory:', 'desktop');
  try {
    store.save('pharmacy-session', { version: 4, engine: 'async-demo', legacyArchive: { revision: 1, value: { version: 3 } } }, 0);
    assert.throws(() => createDesktopDemo({ store }), /存档无效/);
    assert.equal(store.read('async-demo-active'), null);
  } finally { store.close(); }
});

test('actual process exit after archive marker preserves old row and resumes new initialization', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'opspilot-upgrade-exit-'));
  const file = path.join(directory, 'demo.sqlite');
  let store;
  try {
    store = openStateStore(file, 'offline-demo');
    const old = createOfflineStoreDemo({ store }); old.diagnose();
    const p = old.preview(); old.confirm({ previewId: p.id, confirmed: true });
    const original = store.read('pharmacy-session');
    store.close(); store = null;
    const source = `
      import { openStateStore } from ${JSON.stringify(new URL('../src/storage/sqliteStateStore.js', import.meta.url).href)};
      import { createDesktopDemo } from ${JSON.stringify(new URL('../src/demo/desktopDemoFactory.js', import.meta.url).href)};
      const store = openStateStore(${JSON.stringify(file)}, 'offline-demo');
      const wrapped = { read: key => store.read(key), save: (key, value, revision) => {
        const saved = store.save(key, value, revision);
        if (key === 'pharmacy-session' && value.version === 4 && value.legacyArchive) process.kill(process.pid, 'SIGKILL');
        return saved;
      } };
      const demo = createDesktopDemo({ store: wrapped });
      demo.upgrade({ confirmed: true, expectedRevision: ${original.revision} });
      process.exit(99);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { timeout: 15000, encoding: 'utf8', windowsHide: true });
    assert.equal(child.error, undefined);
    assert.equal(child.status, process.platform === 'win32' ? 1 : null);
    assert.equal(child.signal, process.platform === 'win32' ? null : 'SIGKILL');
    store = openStateStore(file, 'offline-demo');
    assert.deepEqual(store.read('pharmacy-session'), { revision: original.revision + 1,
      value: { version: 4, engine: 'async-demo', legacyArchive: original } });
    assert.equal(store.read('async-demo-active'), null);
    const reopened = createDesktopDemo({ store }).snapshot();
    assert.deepEqual(reopened.legacyArchive.task, original.value.state.task);
    assert.equal(reopened.task.status, 'NOT_CHECKED'); assert.equal(reopened.task.approval, null);
    assert.equal(reopened.submissionCount, 0);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('mixed or missing format markers fail closed without choosing a record', () => {
  for (const legacy of [null, { version: 1 }, { version: 4, engine: 'unknown' }]) {
    const store = openStateStore(':memory:', 'desktop');
    try {
      if (legacy) store.save('pharmacy-session', legacy, 0);
      store.save('async-demo-active', { version: 1, sessionId: 'demo-conflict', supplemental: {} }, 0);
      const before = store.read('async-demo-active');
      assert.throws(() => createDesktopDemo({ store }));
      assert.deepEqual(store.read('async-demo-active'), before);
    } finally { store.close(); }
  }
});
