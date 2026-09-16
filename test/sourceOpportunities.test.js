// test/sourceOpportunities.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceOpportunities } from '../src/domain/model/sourceOpportunities.js';

const NOW = '2026-05-05T00:00:00.000Z';
const OBSERVED_AT = '2026-05-04T23:59:00.000Z';

function baseInput(overrides = {}) {
  return {
    observationId: 'obs-1',
    sourceId: 'src-1',
    mode: 'synthetic',
    platformId: 'plat-1',
    storeId: 'store-1',
    observedAt: OBSERVED_AT,
    products: [
      {
        id: 'p-1',
        name: 'Widget',
        price: 1000,
        cost: 500,
        stock: 0,
        referencePrice: 950,
        warehouseAvailable: 4,
      },
    ],
    ...overrides,
  };
}

function baseOptions(overrides = {}) {
  return {
    expectedScope: { platformId: 'plat-1', storeId: 'store-1' },
    now: NOW,
    maxAgeMs: 60 * 60 * 1000,
    minimumMargin: 0.2,
    ...overrides,
  };
}

test('produces pricing and inventory proposals for ready snapshot', () => {
  const result = buildSourceOpportunities(baseInput(), baseOptions());
  const kinds = result.opportunities.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ['inventory', 'pricing']);

  const pricing = result.opportunities.find((o) => o.kind === 'pricing');
  assert.deepEqual(pricing.proposal, { before: 1000, after: 950, cost: 500, margin: (950 - 500) / 950 });
  assert.equal(pricing.productId, 'p-1');
  assert.equal(pricing.requiresApproval, true);
  assert.equal(pricing.executable, false);

  const inventory = result.opportunities.find((o) => o.kind === 'inventory');
  assert.deepEqual(inventory.proposal, { before: 0, value: 4 });

  assert.deepEqual(result.excluded, []);
  assert.equal(result.observation.status, 'READY');
});

test('defaults minimumMargin to 0.2 when omitted', () => {
  const result = buildSourceOpportunities(baseInput(), {
    expectedScope: { platformId: 'plat-1', storeId: 'store-1' },
    now: NOW,
    maxAgeMs: 60 * 60 * 1000,
  });
  assert.equal(result.opportunities.some((o) => o.kind === 'pricing'), true);
});

test('missing cost yields data_quality and no pricing proposal', () => {
  const input = baseInput({
    products: [
      { id: 'p-1', name: 'Widget', price: 1000, cost: null, stock: 0, referencePrice: 950, warehouseAvailable: 4 },
    ],
  });
  const result = buildSourceOpportunities(input, baseOptions());
  assert.equal(result.opportunities.some((o) => o.kind === 'pricing'), false);
  const dq = result.opportunities.filter((o) => o.kind === 'data_quality');
  assert.equal(dq.length, 1);
  assert.equal(dq[0].proposal, null);
  assert.equal(dq[0].executable, false);
  assert.equal(dq[0].requiresApproval, true);
});

test('unknown stock yields no inventory opportunity and no guessed zero', () => {
  const input = baseInput({
    products: [
      { id: 'p-1', name: 'Widget', price: 1000, cost: 500, stock: null, referencePrice: 950, warehouseAvailable: 4 },
    ],
  });
  const result = buildSourceOpportunities(input, baseOptions());
  assert.equal(result.opportunities.some((o) => o.kind === 'inventory'), false);
  assert.equal(result.opportunities.some((o) => o.kind === 'pricing'), true);
});

test('unknown warehouse availability yields no inventory opportunity', () => {
  const input = baseInput({
    products: [
      { id: 'p-1', name: 'Widget', price: 1000, cost: 500, stock: 0, referencePrice: 950, warehouseAvailable: null },
    ],
  });
  const result = buildSourceOpportunities(input, baseOptions());
  assert.equal(result.opportunities.some((o) => o.kind === 'inventory'), false);
});

test('zero cost is known and does not emit data_quality', () => {
  const input = baseInput({ products: [{ id: 'p-1', price: 1000, cost: 0, stock: 5, referencePrice: 950 }] });
  const result = buildSourceOpportunities(input, baseOptions());
  assert.equal(result.opportunities.some((o) => o.kind === 'data_quality'), false);
});

test('stale observation is UNKNOWN with empty arrays', () => {
  const result = buildSourceOpportunities(
    baseInput(),
    baseOptions({ now: '2026-05-10T00:00:00.000Z' }),
  );
  assert.equal(result.observation.status, 'UNKNOWN');
  assert.deepEqual(result.opportunities, []);
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.observation.products, []);
});

test('wrong scope is UNKNOWN with empty arrays', () => {
  const result = buildSourceOpportunities(
    baseInput(),
    baseOptions({ expectedScope: { platformId: 'plat-9', storeId: 'store-9' } }),
  );
  assert.equal(result.observation.status, 'UNKNOWN');
  assert.deepEqual(result.opportunities, []);
  assert.deepEqual(result.excluded, []);
});

test('margin exclusion uses the existing planner reason', () => {
  const input = baseInput({
    products: [{ id: 'p-1', price: 1000, cost: 950, stock: 5, referencePrice: 960 }],
  });
  const result = buildSourceOpportunities(input, baseOptions({ minimumMargin: 0.5 }));
  assert.equal(result.opportunities.some((o) => o.kind === 'pricing'), false);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].productId, 'p-1');
  assert.equal(typeof result.excluded[0].reason, 'string');
  assert.equal(result.excluded[0].reason.length > 0, true);
});

test('missing reference price yields no pricing proposal', () => {
  const input = baseInput({
    products: [{ id: 'p-1', price: 1000, cost: 500, stock: 5 }],
  });
  const result = buildSourceOpportunities(input, baseOptions());
  assert.equal(result.opportunities.some((o) => o.kind === 'pricing'), false);
  assert.equal(result.excluded.length, 0);
});

test('ids are stable and change with observationId', () => {
  const a = buildSourceOpportunities(baseInput(), baseOptions());
  const b = buildSourceOpportunities(baseInput(), baseOptions());
  assert.deepEqual(a.opportunities.map((o) => o.id), b.opportunities.map((o) => o.id));

  const c = buildSourceOpportunities(baseInput({ observationId: 'obs-2' }), baseOptions());
  assert.notDeepEqual(a.opportunities.map((o) => o.id), c.opportunities.map((o) => o.id));
});

test('source identity is preserved on every opportunity', () => {
  const result = buildSourceOpportunities(baseInput(), baseOptions());
  assert.equal(result.opportunities.length > 0, true);
  for (const o of result.opportunities) {
    assert.deepEqual(o.source, {
      observationId: 'obs-1',
      sourceId: 'src-1',
      mode: 'synthetic',
      platformId: 'plat-1',
      storeId: 'store-1',
      observedAt: OBSERVED_AT,
    });
  }
});

test('output is deeply frozen and input is not mutated', () => {
  const input = baseInput();
  const snapshot = JSON.stringify(input);
  const result = buildSourceOpportunities(input, baseOptions());

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.opportunities), true);
  assert.equal(Object.isFrozen(result.excluded), true);
  assert.equal(Object.isFrozen(result.observation), true);
  for (const o of result.opportunities) {
    assert.equal(Object.isFrozen(o), true);
    assert.equal(Object.isFrozen(o.source), true);
    if (o.proposal) assert.equal(Object.isFrozen(o.proposal), true);
  }

  assert.equal(JSON.stringify(input), snapshot);
});

test('invalid options are rejected', () => {
  assert.throws(() => buildSourceOpportunities(baseInput(), { unknown: 1 }), TypeError);
  assert.throws(() => buildSourceOpportunities(baseInput(), { expectedScope: {} , now: NOW, maxAgeMs: 1, nope: 2 }), TypeError);
  assert.throws(() => buildSourceOpportunities(baseInput(), 'nope'), TypeError);
  assert.throws(() => buildSourceOpportunities(baseInput(), { get now() { return NOW; } }), TypeError);
  assert.throws(() => buildSourceOpportunities(baseInput(), { [Symbol('x')]: 1 }), TypeError);
});

test('invalid margin is rejected', () => {
  assert.throws(() => buildSourceOpportunities(baseInput(), baseOptions({ minimumMargin: NaN })), TypeError);
  assert.throws(() => buildSourceOpportunities(baseInput(), baseOptions({ minimumMargin: Infinity })), TypeError);
  assert.throws(() => buildSourceOpportunities(baseInput(), baseOptions({ minimumMargin: -0.1 })), RangeError);
  assert.throws(() => buildSourceOpportunities(baseInput(), baseOptions({ minimumMargin: 1.5 })), RangeError);
  assert.throws(() => buildSourceOpportunities(baseInput(), baseOptions({ minimumMargin: '0.2' })), TypeError);
});

test('margin is validated even for unknown snapshots', () => {
  assert.throws(
    () => buildSourceOpportunities(baseInput(), baseOptions({ now: '2026-05-10T00:00:00.000Z', minimumMargin: 2 })),
    RangeError,
  );
});

test('host mode is preserved and never rewritten to synthetic', () => {
  const result = buildSourceOpportunities(baseInput({ mode: 'host' }), baseOptions());
  assert.equal(result.observation.mode, 'host');
  for (const o of result.opportunities) assert.equal(o.source.mode, 'host');
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});
