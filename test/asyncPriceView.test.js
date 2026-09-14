import test from 'node:test';
import assert from 'node:assert/strict';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { openAsyncPriceSession } from '../src/demo/asyncPriceSession.js';
import { projectAsyncPriceView } from '../src/demo/asyncPriceView.js';
const products = [{ id: 'DEMO-001', name: '演示商品 A', price: 2000, target: 1800, cost: 1000, stock: 12 }];

test('view follows persistent consent and independent verification without changing records', async () => {
  const store = openStateStore(':memory:', 'view-test');
  try {
    const session = openAsyncPriceSession({ store, sessionId: 'view', products, create: true });
    const view = () => projectAsyncPriceView(session.snapshot());
    assert.equal(view().diagnosis, null); assert.equal(view().review, null);
    await session.check(); await session.preview();
    assert.equal(view().action, null);
    const plan = view().preview;
    await session.confirm({ planId: plan.id, confirmed: true });
    assert.equal(view().action.status, 'pending'); assert.equal(view().task.run, null);
    await session.execute({ scenario: 'response_lost' });
    assert.equal(view().task.status, 'UNKNOWN'); assert.equal(view().review, null);
    await session.readback();
    assert.equal(view().review.matchedCount, 1); assert.equal(view().task.status, 'VERIFIED');
    const before = session.snapshot(); const displayed = view();
    displayed.task.status = 'UNKNOWN'; displayed.products[0].price = 0;
    assert.deepEqual(session.snapshot(), before);
    assert.equal(view().review.actualProfitImpact, null);
  } finally { store.close(); }
});

test('view rejects a mismatched scope or preview and does not treat unavailable readback as review', async () => {
  const store = openStateStore(':memory:', 'view-test');
  try {
    const session = openAsyncPriceSession({ store, sessionId: 'view', products, create: true });
    await session.check(); await session.preview();
    await session.confirm({ planId: session.snapshot().task.plan.id, confirmed: true });
    await session.execute({ scenario: 'readback_unavailable' }); await session.readback();
    const snapshot = session.snapshot();
    assert.equal(projectAsyncPriceView(snapshot).review, null);
    assert.equal(projectAsyncPriceView(snapshot).task.status, 'UNKNOWN');
    snapshot.platform.identity.sessionId = 'another';
    assert.throws(() => projectAsyncPriceView(snapshot), /scope/);
    const changed = session.snapshot(); changed.details.items[0].after = 1;
    assert.throws(() => projectAsyncPriceView(changed), /plan/);
  } finally { store.close(); }
});
