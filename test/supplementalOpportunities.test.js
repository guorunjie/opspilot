import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { createOfflineStoreDemo } from '../src/demo/offlineStoreDemo.js';
import { planStockout, planCampaign } from '../src/domain/model/operationPlanning.js';

for (const kind of ['inventory', 'campaign']) for (const scenario of ['normal', 'response_lost', 'mismatch', 'readback_unavailable']) {
  test(`${kind}: ${scenario} completes independently, persists and resets`, () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'opspilot-opportunity-')), 'demo.sqlite');
    let store = openStateStore(file, 'offline_demo'), demo = createOfflineStoreDemo({ store });
    const reopen = () => { store.close(); store = openStateStore(file, 'offline_demo'); demo = createOfflineStoreDemo({ store }); };
    const command = (operation, extra = {}) => demo.opportunity({ kind, operation, ...extra });
    try {
      assert.throws(() => command('preview'));
      demo.diagnose();
      const priceBefore = demo.snapshot().task;
      command('preview');
      const planId = demo.snapshot().supplemental[kind].task.plan.id;
      assert.throws(() => command('execute'));
      assert.throws(() => command('confirm', { planId, confirmed: false }));
      command('confirm', { planId, confirmed: true });
      reopen();
      command('execute', { scenario });
      let record = demo.snapshot().supplemental[kind];
      assert.equal(record.task.status, scenario === 'response_lost' ? 'UNKNOWN' : 'SUBMITTED');
      assert.equal(record.review, null);
      assert.equal(store.read('pharmacy-session').value.version, 3);
      reopen();
      assert.deepEqual(demo.snapshot().supplemental[kind], record);
      assert.throws(() => command('execute'));
      command('readback');
      if (scenario === 'readback_unavailable') {
        record = demo.snapshot().supplemental[kind];
        assert.equal(record.task.status, 'UNKNOWN');
        assert.equal(record.review.items[0].observed, null);
        reopen(); assert.deepEqual(demo.snapshot().supplemental[kind], record);
        command('readback');
      }
      record = demo.snapshot().supplemental[kind];
      assert.equal(record.task.status, scenario === 'mismatch' ? 'FAILED' : 'VERIFIED');
      assert.equal(record.review.actualProfitImpact, null);
      assert.equal(record.submissionCount, 1);
      assert.deepEqual(demo.snapshot().task, priceBefore);
      assert.equal(demo.snapshot().submissionCount, 0);
      assert.throws(() => command('readback'));
      reopen(); assert.deepEqual(demo.snapshot().supplemental[kind], record);
      const reset = demo.reset();
      assert.equal(reset.supplemental, undefined);
      assert.equal(store.read('pharmacy-session').value.version, 2);
      demo.diagnose(); command('preview');
      assert.notEqual(demo.snapshot().supplemental[kind].task.plan.id, planId);
      assert.throws(() => command('confirm', { planId, confirmed: true }));
    } finally { store.close(); }
  });
}

test('stockout and campaign rules preserve missing data and exclusion semantics', () => {
  for (const missing of [null, undefined, NaN, '0', -1]) {
    assert.deepEqual(planStockout({ productId: 'A', stock: missing, warehouseAvailable: 12 }).items, []);
    assert.deepEqual(planStockout({ productId: 'A', stock: 0, warehouseAvailable: missing }).items, []);
    assert.deepEqual(planCampaign({ productId: 'A', campaignPrice: 1800, cost: missing, eligible: true, enrolled: false }).items, []);
  }
  assert.equal(planStockout({ productId: 'A', stock: 0, warehouseAvailable: 12 }).items[0].value, 12);
  assert.equal(planStockout({ productId: 'A', stock: 0, warehouseAvailable: 0 }).items.length, 0);
  for (const values of [{ eligible: null }, { enrolled: null }, { enrolled: true }, { cost: 1700 }, { campaignPrice: 0 }])
    assert.equal(planCampaign({ productId: 'A', campaignPrice: 1800, cost: 1000, eligible: true, enrolled: false, ...values }).items.length, 0);
  assert.equal(planCampaign({ productId: 'A', campaignPrice: 1800, cost: 0, eligible: true, enrolled: false }).items.length, 1);
});

test('a confirmed price task cannot authorize inventory or campaign; plans are scoped', () => {
  const demo = createOfflineStoreDemo(); demo.diagnose();
  const price = demo.preview(); demo.confirm({ previewId: price.id, confirmed: true });
  for (const kind of ['inventory', 'campaign']) {
    demo.opportunity({ kind, operation: 'preview' });
    assert.throws(() => demo.opportunity({ kind, operation: 'confirm', planId: price.id, confirmed: true }));
    assert.throws(() => demo.opportunity({ kind, operation: 'execute' }));
  }
  const inventory = demo.snapshot().supplemental.inventory.task.plan.id;
  assert.throws(() => demo.opportunity({ kind: 'campaign', operation: 'confirm', planId: inventory, confirmed: true }));
  demo.execute(); assert.equal(demo.readback().task.status, 'VERIFIED');
  assert.equal(demo.snapshot().supplemental.inventory.task.approval, null);
});

test('corrupt or downgraded new archives are rejected without rewriting them', () => {
  for (const corrupt of [r => { r.version = 2; }, r => { delete r.state.supplemental; },
    r => { r.state.supplemental.inventory.values[0][1] = 99; },
    r => { r.state.supplemental.inventory.task.status = 'VERIFIED'; },
    r => { r.state.supplemental.inventory.task.plan.items[0].value = 99; },
    r => { r.state.supplemental.inventory.kind = 'campaign'; }]) {
    const store = openStateStore(':memory:', 'offline_demo');
    try {
      const demo = createOfflineStoreDemo({ store }); demo.diagnose(); demo.opportunity({ kind: 'inventory', operation: 'preview' });
      const record = store.read('pharmacy-session'); corrupt(record.value);
      store.save('pharmacy-session', record.value, record.revision);
      const before = store.read('pharmacy-session');
      assert.throws(() => createOfflineStoreDemo({ store }));
      assert.deepEqual(store.read('pharmacy-session'), before);
    } finally { store.close(); }
  }
});

test('post-commit lost save response reopens supplemental target without a duplicate write', () => {
  const store = openStateStore(':memory:', 'offline_demo');
  let lose = false;
  const wrapped = { read: store.read, save(...args) { const revision = store.save(...args); if (lose) throw new Error('lost'); return revision; } };
  try {
    const demo = createOfflineStoreDemo({ store: wrapped }); demo.diagnose();
    demo.opportunity({ kind: 'inventory', operation: 'preview' });
    demo.opportunity({ kind: 'inventory', operation: 'confirm', planId: demo.snapshot().supplemental.inventory.task.plan.id, confirmed: true });
    lose = true;
    assert.throws(() => demo.opportunity({ kind: 'inventory', operation: 'execute' }));
    assert.throws(() => demo.reset());
    const reopened = createOfflineStoreDemo({ store });
    assert.equal(reopened.snapshot().supplemental.inventory.submissionCount, 1);
    assert.throws(() => reopened.opportunity({ kind: 'inventory', operation: 'execute' }));
    assert.equal(reopened.opportunity({ kind: 'inventory', operation: 'readback' }).supplemental.inventory.task.status, 'VERIFIED');
  } finally { store.close(); }
});
