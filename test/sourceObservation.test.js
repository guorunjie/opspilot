// test/sourceObservation.test.js
// No network, no real data. Plain structural assertions via node:assert.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSourceObservation as normalize } from '../src/domain/model/sourceObservation.js';

const NOW = '2024-05-01T12:00:00.000Z';
const OBS = '2024-05-01T11:59:00.000Z';
const SCOPE = { platformId: 'plat-1', storeId: 'store-1' };

const baseInput = (over = {}) => ({
  observationId: 'obs-1',
  sourceId: 'src-1',
  mode: 'synthetic',
  platformId: 'plat-1',
  storeId: 'store-1',
  observedAt: OBS,
  products: [{ id: 'p1', price: 100, cost: 50, stock: 3 }],
  ...over,
});

const opts = (over = {}) => ({ expectedScope: SCOPE, now: NOW, maxAgeMs: 60000, ...over });

test('READY on fresh in-scope observation and echoes explicit mode', () => {
  const out = normalize(baseInput(), opts());
  assert.equal(out.status, 'READY');
  assert.equal(out.reason, 'fresh_observation');
  assert.equal(out.mode, 'synthetic');
  assert.equal(out.observedAt, OBS);
  assert.equal(normalize(baseInput({ mode: 'host' }), opts()).mode, 'host');
  assert.ok(!('identityVerified' in out) && !('verified' in out));
});

test('preserves zero and maps missing/absent values to null', () => {
  const out = normalize(
    baseInput({ products: [{ id: 'p1', price: 0, cost: 0, stock: 0 }, { id: 'p2', price: null }] }),
    opts(),
  );
  assert.deepEqual(out.products[0], {
    id: 'p1', name: 'p1', price: 0, cost: 0, stock: 0, referencePrice: null, warehouseAvailable: null,
  });
  assert.equal(out.products[1].price, null);
  assert.equal(out.products[1].cost, null);
  assert.equal(out.products[1].name, 'p2'); // name defaults to id
});

test('coverage counts known metrics including zero, missing is never counted', () => {
  const out = normalize(
    baseInput({
      products: [
        { id: 'a', price: 0, cost: null, stock: 1 },
        { id: 'b', price: 5, cost: 7 },
        { id: 'c' },
      ],
    }),
    opts(),
  );
  assert.deepEqual(out.coverage, {
    productCount: 3, priceKnownCount: 2, costKnownCount: 1, stockKnownCount: 1,
  });
});

test('fresh exact boundary is READY', () => {
  const out = normalize(baseInput({ observedAt: '2024-05-01T11:59:00.000Z' }), opts({ maxAgeMs: 60000 }));
  assert.equal(out.status, 'READY');
  const edge = normalize(
    baseInput({ observedAt: '2024-05-01T11:59:59.999Z' }),
    opts({ maxAgeMs: 1 }),
  );
  assert.equal(edge.status, 'READY');
});

test('stale observation is redacted', () => {
  const out = normalize(baseInput(), opts({ maxAgeMs: 30000 }));
  assert.equal(out.status, 'UNKNOWN');
  assert.equal(out.reason, 'stale_observation');
  assert.deepEqual(out.products, []);
  assert.equal(out.coverage, null);
});

test('future observation is redacted', () => {
  const out = normalize(baseInput({ observedAt: '2024-05-01T12:00:00.001Z' }), opts());
  assert.equal(out.status, 'UNKNOWN');
  assert.equal(out.reason, 'future_observation');
  assert.deepEqual(out.products, []);
  assert.equal(out.coverage, null);
});

test('scope mismatch is redacted and takes precedence over staleness', () => {
  const out = normalize(
    baseInput({ platformId: 'plat-2', observedAt: '2020-01-01T00:00:00.000Z' }),
    opts(),
  );
  assert.equal(out.reason, 'scope_mismatch');
  assert.deepEqual(out.products, []);
  assert.equal(out.coverage, null);
  const storeMismatch = normalize(baseInput({ storeId: 'other' }), opts());
  assert.equal(storeMismatch.reason, 'scope_mismatch');
});

test('empty product list is valid', () => {
  const out = normalize(baseInput({ products: [] }), opts());
  assert.equal(out.status, 'READY');
  assert.deepEqual(out.products, []);
  assert.deepEqual(out.coverage, {
    productCount: 0, priceKnownCount: 0, costKnownCount: 0, stockKnownCount: 0,
  });
});

test('duplicate product ids are rejected', () => {
  assert.throws(
    () => normalize(baseInput({ products: [{ id: 'x' }, { id: 'x' }] }), opts()),
    TypeError,
  );
});

test('invalid amounts are rejected', () => {
  for (const bad of [-1, 1.5, '5', NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => normalize(baseInput({ products: [{ id: 'p', price: bad }] }), opts()), TypeError);
  }
  assert.throws(
    () => normalize(baseInput({ products: [{ id: 'p', stock: -0.5 }] }), opts()),
    TypeError,
  );
});

test('extra key, symbol key, and getter on input are rejected without executing the getter', () => {
  assert.throws(() => normalize(baseInput({ extra: 1 }), opts()), TypeError);

  const withSymbol = baseInput();
  withSymbol[Symbol('s')] = 1;
  assert.throws(() => normalize(withSymbol, opts()), TypeError);

  let executed = false;
  const hostile = baseInput();
  Object.defineProperty(hostile, 'sourceId', {
    enumerable: true,
    get() { executed = true; return 'src-1'; },
  });
  assert.throws(() => normalize(hostile, opts()), TypeError);
  assert.equal(executed, false);
});

test('array holes and indexed getters are rejected without execution', () => {
  const sparse = baseInput({ products: [{ id: 'a' }, , { id: 'b' }] });
  assert.throws(() => normalize(sparse, opts()), TypeError);

  let executed = false;
  const products = [{ id: 'a' }];
  Object.defineProperty(products, '1', { enumerable: true, get() { executed = true; return { id: 'b' }; } });
  products.length = 2;
  assert.throws(() => normalize(baseInput({ products }), opts()), TypeError);
  assert.equal(executed, false);

  const custom = [{ id: 'a' }];
  custom.extra = true;
  assert.throws(() => normalize(baseInput({ products: custom }), opts()), TypeError);
});

test('output is a normalized copy and deeply frozen', () => {
  const source = { id: 'p1', name: 'Widget', price: 10 };
  const products = [source];
  const out = normalize(baseInput({ products }), opts());
  assert.notEqual(out.products[0], source);
  assert.equal(source.price, 10);
  Object.assign(source, { price: 999 });
  assert.equal(out.products[0].price, 10);
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.products) && Object.isFrozen(out.products[0]));
  assert.ok(Object.isFrozen(out.coverage));
  assert.throws(() => { out.products[0].price = 1; }, TypeError);
});

test('invalid timestamps and options are rejected', () => {
  assert.throws(() => normalize(baseInput({ observedAt: '2024-05-01T11:59:00Z' }), opts()), TypeError);
  assert.throws(() => normalize(baseInput({ observedAt: '2024-05-01 11:59:00.000Z' }), opts()), TypeError);
  assert.throws(() => normalize(baseInput({ observedAt: 0 }), opts()), TypeError);
  assert.throws(() => normalize(baseInput(), opts({ now: 'not-a-date' })), TypeError);
  assert.throws(() => normalize(baseInput(), opts({ maxAgeMs: 0 })), TypeError);
  assert.throws(() => normalize(baseInput(), opts({ maxAgeMs: 1.5 })), TypeError);
  assert.throws(() => normalize(baseInput(), opts({ maxAgeMs: 86400001 })), TypeError);
  assert.throws(() => normalize(baseInput(), opts({ expectedScope: { platformId: 'plat-1' } })), TypeError);
});

test('missing options or unknown option keys throw TypeError', () => {
  assert.throws(() => normalize(baseInput()), TypeError);
  assert.throws(() => normalize(baseInput(), {}), TypeError);
  assert.throws(() => normalize(baseInput(), opts({ extra: 1 })), TypeError);
  assert.throws(() => normalize(baseInput(), null), TypeError);
});

test('string rules are enforced', () => {
  assert.throws(() => normalize(baseInput({ observationId: '' }), opts()), TypeError);
  assert.throws(() => normalize(baseInput({ sourceId: '  src-1 ' }), opts()), TypeError);
  assert.throws(() => normalize(baseInput({ sourceId: 'a'.repeat(129) }), opts()), TypeError);
  assert.throws(() => normalize(baseInput({ sourceId: 'a\u0000b' }), opts()), TypeError);
  assert.throws(() => normalize(baseInput({ mode: 'live' }), opts()), TypeError);
  assert.throws(() => normalize(baseInput({ products: [{ id: '  ' }] }), opts()), TypeError);
  assert.throws(() => normalize(baseInput({ products: [{ id: 'p', name: '' }] }), opts()), TypeError);
});

test('malformed products throw even when scope is wrong', () => {
  assert.throws(
    () => normalize(baseInput({ platformId: 'other', products: [{ id: 'p', price: -3 }] }), opts()),
    TypeError,
  );
  assert.throws(
    () => normalize(baseInput({ platformId: 'other', products: [{ id: 'p', nope: 1 }] }), opts()),
    TypeError,
  );
  assert.throws(
    () => normalize(baseInput({ platformId: 'other', products: 'nope' }), opts()),
    TypeError,
  );
});

test('product count limit is enforced', () => {
  const many = Array.from({ length: 10001 }, (_, i) => ({ id: `p${i}` }));
  assert.throws(() => normalize(baseInput({ products: many }), opts()), TypeError);
});

test('expected scope values are validated before comparison', () => {
  for (const bad of ['', ' store-1 ', null, 42, 'x\u0000y']) {
    assert.throws(() => normalize(baseInput(), opts({ expectedScope: { platformId: 'plat-1', storeId: bad } })), TypeError);
  }
});

test('custom array prototype and oversized sparse input are rejected', () => {
  const products = [{ id: 'p' }];
  Object.setPrototypeOf(products, Object.create(Array.prototype));
  assert.throws(() => normalize(baseInput({ products }), opts()), TypeError);
  assert.throws(() => normalize(baseInput({ products: new Array(10001) }), opts()), TypeError);
});
