import test from 'node:test';
import assert from 'node:assert/strict';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { createOfflineStoreDemo } from '../src/demo/offlineStoreDemo.js';
import { assertTask } from '../src/task/taskState.js';

function confirmed(demo) {
  demo.diagnose();
  const plan = demo.preview();
  demo.confirm({ previewId: plan.id, confirmed: true });
}

for (const scenario of ['normal', 'response_lost', 'mismatch', 'readback_unavailable']) {
  test(`Demo canonical task persists each user command: ${scenario}`, () => {
    const store = openStateStore(':memory:', 'offline_demo');
    try {
      let demo = createOfflineStoreDemo({ store });
      assert.equal(demo.snapshot().task.status, 'NOT_CHECKED');
      confirmed(demo);
      assert.equal(demo.snapshot().task.status, 'AWAITING_APPROVAL');
      assert.ok(demo.snapshot().task.approval);
      demo = createOfflineStoreDemo({ store });
      const result = demo.execute({ scenario });
      assert.equal(result.task.status, scenario === 'response_lost' ? 'UNKNOWN' : 'SUBMITTED');
      assert.equal(result.task.verifications.length, 0);
      demo = createOfflineStoreDemo({ store });
      assert.deepEqual(demo.snapshot(), result);
      assert.throws(() => demo.execute());
      let read = demo.readback();
      if (scenario === 'readback_unavailable') {
        assert.equal(read.task.status, 'UNKNOWN');
        assert.equal(read.task.verifications[0].items[0].observed, null);
        demo = createOfflineStoreDemo({ store });
        assert.deepEqual(demo.snapshot(), read);
        read = demo.readback();
      }
      assert.equal(read.task.status, scenario === 'mismatch' ? 'FAILED' : 'VERIFIED');
      assertTask(read.task);
      assert.equal(read.task.history.filter(event => event.type === 'START').length, 1);
      assert.deepEqual(createOfflineStoreDemo({ store }).snapshot(), read);
      assert.equal(store.read('pharmacy-session').value.version, 2);
      demo.reset();
      assert.equal(demo.snapshot().task.status, 'NOT_CHECKED');
      assert.equal(demo.snapshot().task.history.length, 0);
    } finally { store.close(); }
  });
}

test('v1 synthetic checkpoints retain legacy history until explicit reset', () => {
  const store = openStateStore(':memory:', 'offline_demo');
  try {
    const demo = createOfflineStoreDemo({ store });
    confirmed(demo);
    demo.execute({ scenario: 'response_lost' });
    const record = store.read('pharmacy-session');
    // Reproduce the prior schema, not a claim of a real installed upgrade.
    delete record.value.state.task;
    record.value.version = 1;
    store.save('pharmacy-session', record.value, record.revision);
    const before = store.read('pharmacy-session');
    const legacy = createOfflineStoreDemo({ store });
    assert.deepEqual(store.read('pharmacy-session'), before, 'open must not rewrite old history');
    assert.equal(legacy.snapshot().task, undefined);
    assert.throws(() => legacy.execute());
    assert.equal(legacy.readback().action.status, 'succeeded');
    assert.equal(store.read('pharmacy-session').value.version, 1);
    assert.equal(legacy.reset().task.status, 'NOT_CHECKED');
    assert.equal(store.read('pharmacy-session').value.version, 2);
  } finally { store.close(); }
});

test('missing or forged v2 task is rejected without rewriting storage', () => {
  for (const corrupt of [s => { delete s.task; }, s => { s.task.status = 'VERIFIED'; },
    s => { s.task.plan.items[0].value = 0; }, s => { s.task.history = []; }]) {
    const store = openStateStore(':memory:', 'offline_demo');
    try {
      const demo = createOfflineStoreDemo({ store });
      confirmed(demo);
      const record = store.read('pharmacy-session');
      corrupt(record.value.state);
      store.save('pharmacy-session', record.value, record.revision);
      const before = store.read('pharmacy-session');
      assert.throws(() => createOfflineStoreDemo({ store }));
      assert.deepEqual(store.read('pharmacy-session'), before);
    } finally { store.close(); }
  }
});
