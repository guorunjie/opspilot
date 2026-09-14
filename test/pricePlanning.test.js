import test from 'node:test';
import assert from 'node:assert/strict';
import { planPrices, diagnoseProducts, createRulePricePlanner } from '../src/domain/model/pricePlanning.js';
import { createOfflineStoreDemo } from '../src/demo/offlineStoreDemo.js';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
const product = (values = {}) => ({ id: 'p1', name: 'Synthetic item', price: 2000, target: 1800, cost: 1000, stock: 3, ...values });

test('diagnosis and rule planner agree on eligible products without authorizing anything', () => {
  const products = [product(), product({ id: 'p2', cost: null }), product({ id: 'p3', target: null, stock: 0 })];
  const plan = createRulePricePlanner().proposePlan({ products });
  const diagnosis = diagnoseProducts(products);
  assert.equal(diagnosis.repricingCandidateCount, plan.items.length);
  assert.equal(plan.items.length, 1);
  assert.equal(diagnosis.missingCostCount, 1); assert.equal(diagnosis.stockoutCount, 1);
  assert.deepEqual(diagnosis.priorities.map(p => p.productId), ['p2', 'p3', 'p1']);
  assert.deepEqual(plan.excluded, [{ productId: 'p2', reason: 'missing_cost' }]);
  assert.equal(plan.approval, undefined); assert.equal(plan.status, undefined);
});

test('missing data never becomes numeric zero or a known stockout', () => {
  const products = [product({ cost: null, stock: null }), product({ id: 'p2', cost: 0, stock: 0 })];
  const diagnosis = diagnoseProducts(products);
  assert.equal(diagnosis.stockoutCount, 1); assert.equal(diagnosis.missingCostCount, 1);
  assert.deepEqual(diagnosis.dataCoverage, { productCount: 2, costKnownCount: 1, stockKnownCount: 1 });
  assert.equal(planPrices(products).items[0].cost, 0);
  assert.equal(planPrices([product({ target: null })]).items.length, 0);
});

test('invalid targets, stale no-op prices and margin floor failures are excluded', () => {
  for (const target of [0, -1, '1800', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(planPrices([product({ target })]).excluded[0].reason, 'invalid_target');
  }
  assert.equal(planPrices([product({ target: 2000 })]).excluded[0].reason, 'already_at_target');
  assert.equal(planPrices([product({ cost: 1700 })]).excluded[0].reason, 'margin_below_floor');
  assert.equal(planPrices([product({ price: null })]).excluded[0].reason, 'missing_price');
  assert.equal(planPrices([product({ cost: '1000' })]).excluded[0].reason, 'missing_cost');
  assert.equal(planPrices([product({ target: 100, cost: 80 })]).items.length, 1, 'exact margin floor is allowed');
});

test('empty inputs report absent coverage and unsafe product identities are rejected', () => {
  assert.deepEqual(diagnoseProducts([]).dataCoverage, { productCount: 0, costKnownCount: 0, stockKnownCount: 0 });
  for (const input of [null, new Array(1), [product(), product()], [product({ id: '' })]]) assert.throws(() => planPrices(input));
  for (const minimumMargin of [-1, 2, NaN, '0.2']) assert.throws(() => planPrices([product()], { minimumMargin }));
});

test('planner outputs do not mutate or alias product data', () => {
  const p = Object.freeze(product()); const source = Object.freeze([p]);
  const plan = planPrices(source); plan.items[0].after = 0;
  assert.equal(p.target, 1800); assert.equal(planPrices(source).items[0].after, 1800);
});

test('actual Demo uses rule diagnosis and proposed items but still requires confirmation', () => {
  const demo = createOfflineStoreDemo(); const diagnosed = demo.diagnose();
  assert.equal(diagnosed.diagnosis.ruleVersion, 1);
  assert.deepEqual(diagnosed.diagnosis.dataCoverage, { productCount: 3, costKnownCount: 2, stockKnownCount: 3 });
  const preview = demo.preview();
  assert.deepEqual(preview.items, planPrices(diagnosed.products).items);
  assert.equal(demo.snapshot().task.approval, null); assert.throws(() => demo.execute());
});

test('saved rule facts and preview exclusions are checked without overwriting corrupt data', () => {
  for (const corrupt of [s => { s.diagnosis.repricingCandidateCount = 99; }, s => { s.preview.excluded = []; }]) {
    const store = openStateStore(':memory:', 'offline_demo');
    try {
      const demo = createOfflineStoreDemo({ store }); demo.diagnose(); demo.preview();
      const record = store.read('pharmacy-session'); corrupt(record.value.state);
      store.save('pharmacy-session', record.value, record.revision);
      const before = store.read('pharmacy-session');
      assert.throws(() => createOfflineStoreDemo({ store }));
      assert.deepEqual(store.read('pharmacy-session'), before);
    } finally { store.close(); }
  }
});
