import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { createOfflineStoreDemo } from '../src/demo/offlineStoreDemo.js';

for (const scenario of ['normal', 'response_lost', 'mismatch']) {
  test(`persisted Demo resumes ${scenario} with readback, never resubmission`, t => {
    const root = mkdtempSync(path.join(tmpdir(), 'opspilot-demo-resume-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'demo.sqlite');
    let store = openStateStore(file, 'offline-demo');
    let demo = createOfflineStoreDemo({ store });
    demo.diagnose();
    const preview = demo.preview();
    demo.confirm({ previewId: preview.id, confirmed: true });
    demo.execute({ scenario });
    const submitted = demo.snapshot();
    store.close();
    store = openStateStore(file, 'offline-demo');
    try {
      demo = createOfflineStoreDemo({ store });
      assert.deepEqual(demo.snapshot(), submitted);
      assert.equal(demo.snapshot().executionScenario, scenario);
      assert.equal(demo.snapshot().review, null);
      assert.throws(() => demo.execute(), /重复/);
      const verified = demo.readback();
      assert.equal(verified.submissionCount, 1);
      assert.equal(verified.action.status, scenario === 'mismatch' ? 'readback_inconsistent' : 'succeeded');
      assert.equal(verified.review.realPlatformVerified, false);
      const reopened = createOfflineStoreDemo({ store });
      assert.deepEqual(reopened.snapshot(), verified);
      demo.reset();
      assert.equal(createOfflineStoreDemo({ store }).snapshot().submissionCount, 0);
      assert.equal(createOfflineStoreDemo({ store }).snapshot().executionScenario, null);
    } finally { store.close(); }
  });
}

test('failed persistence poisons the instance rather than reporting a successful command', () => {
  let row;
  const store = { read: () => row, save: (_key, value) => {
    if (row) throw new Error('disk unavailable');
    row = { revision: 1, value: structuredClone(value) }; return 1;
  } };
  const demo = createOfflineStoreDemo({ store });
  assert.throws(() => demo.diagnose(), /disk unavailable/);
  assert.throws(() => demo.preview(), /重新打开/);
});

test('inconsistent saved success is rejected without overwriting the record', () => {
  let row;
  const store = { read: () => structuredClone(row), save: (_key, value, revision) => {
    row = { revision: revision + 1, value: structuredClone(value) }; return row.revision;
  } };
  const demo = createOfflineStoreDemo({ store });
  demo.diagnose(); const preview = demo.preview();
  demo.confirm({ previewId: preview.id, confirmed: true }); demo.execute(); demo.readback();
  const good = structuredClone(row);
  for (const corrupt of [
    s => { s.action.evidence = null; },
    s => { s.review = null; },
    s => { s.review.items = []; },
    s => { s.submissionCount = 0; },
    s => { s.action.platformId = 'real-platform'; },
    s => { s.preview.items[0].after = 1; },
    s => { s.action.authorizationEvidenceId = null; },
    s => { s.products[0].cost = 0; },
    s => { s.action.status = 'pending'; },
    s => { s.review.realPlatformVerified = true; },
    s => { s.readbackAttempts = []; },
    s => { s.readbackAttempts[0].status = 'UNKNOWN'; },
    s => { s.readbackAttempts[0].realPlatformVerified = true; },
    s => { s.executionScenario = 'readback_unavailable'; }
  ]) {
    row = structuredClone(good); corrupt(row.value.state);
    const before = structuredClone(row);
    assert.throws(() => createOfflineStoreDemo({ store }), /存档/);
    assert.deepEqual(row, before);
  }
});
