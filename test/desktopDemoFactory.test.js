import test from 'node:test';
import assert from 'node:assert/strict';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { createDesktopDemo } from '../src/demo/desktopDemoFactory.js';
import { createOfflineStoreDemo } from '../src/demo/offlineStoreDemo.js';

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
    assert.deepEqual(opened.snapshot(), old.snapshot());
    assert.deepEqual(store.read('pharmacy-session'), row);
    assert.equal(store.read('async-demo-active'), null);
    assert.equal(opened.snapshot().submissionCount, 0);
  } finally { store.close(); }
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
