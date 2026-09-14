import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPriceConnector } from '../src/connector/mockPriceConnector.js';
const prices = () => [['a', 20], ['b', 0]];
const request = () => ({ planId: 'p1', storeId: 's1', items: [
  { targetId: 'a', before: 20, value: 18 }, { targetId: 'b', before: 0, value: 5 }] });
const create = () => createMockPriceConnector({ storeId: 's1', prices: prices() });

test('mock submission and scoped readback are separate, zero remains a real value', () => {
  const connector = create();
  assert.equal(connector.checkWrite(request()), true);
  assert.deepEqual(connector.apply(request()), { status: 'SUBMITTED', simulated: true, realPlatformVerified: false });
  assert.deepEqual(connector.read(request()), { planId: 'p1', connectorId: 'offline_demo', storeId: 's1',
    items: [{ targetId: 'a', value: 18 }, { targetId: 'b', value: 5 }] });
  assert.throws(() => connector.apply(request()), 'original values are stale after applying');
});

test('failed multi-item precondition never changes the earlier valid target', () => {
  for (const change of [r => { r.items[1].before = 1; }, r => { r.items[1].targetId = 'missing'; },
    r => { r.items[1].value = null; }, r => { r.items[1].value = '5'; }, r => { r.items[1].value = -1; }]) {
    const connector = create(); const input = request(); change(input);
    assert.throws(() => connector.apply(input));
    assert.deepEqual(connector.snapshot(), prices());
  }
});

test('wrong store, duplicate or sparse targets fail before any mutation', () => {
  for (const change of [r => { r.storeId = 'other'; }, r => { r.planId = ''; },
    r => { r.items = [r.items[0], r.items[0]]; }, r => { r.items = new Array(1); }, r => { r.items = []; }]) {
    const connector = create(); const input = request(); change(input);
    assert.throws(() => connector.apply(input));
    assert.throws(() => connector.read(input));
    assert.deepEqual(connector.snapshot(), prices());
  }
});

test('mismatch is a submitted mock with unchanged values; missing readback is null', () => {
  const connector = create();
  assert.equal(connector.apply(request(), { mismatch: true }).status, 'SUBMITTED');
  assert.deepEqual(connector.snapshot(), prices());
  assert.deepEqual(connector.read({ planId: 'p1', storeId: 's1', items: [{ targetId: 'b' }, { targetId: 'missing' }] }).items,
    [{ targetId: 'b', value: 0 }, { targetId: 'missing', value: null }]);
});

test('constructor and snapshots do not alias and invalid initial data is rejected', () => {
  const rows = prices(); const connector = createMockPriceConnector({ storeId: 's1', prices: rows });
  rows[0][1] = 999; const snapshot = connector.snapshot(); snapshot[0][1] = 777;
  assert.deepEqual(connector.snapshot(), prices());
  for (const invalid of [[], new Array(1), [['a', null]], [['a', -1]], [['a', 1.2]], [['a', Number.MAX_SAFE_INTEGER + 1]], [['a', 1], ['a', 2]]]) {
    assert.throws(() => createMockPriceConnector({ storeId: 's1', prices: invalid }));
  }
});
