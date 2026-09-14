import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPriceCapabilities } from '../src/demo/demoPriceCapabilities.js';
import { createOfflineStoreDemo } from '../src/demo/offlineStoreDemo.js';
import { advanceTask } from '../src/task/taskState.js';
import { transitionPlatformAction } from '../src/domain/model/platformActionProtocol.js';

function setup() {
  const demo = createOfflineStoreDemo(); demo.diagnose(); const preview = demo.preview();
  const state = demo.confirm({ previewId: preview.id, confirmed: true });
  state.task = advanceTask(state.task, { type: 'START', runId: 'test-run' });
  state.action = transitionPlatformAction(state.action, 'running');
  let writes = 0;
  const registry = createDemoPriceCapabilities({ getState: () => state, getConnector: () => ({
    checkWrite: () => true, apply: () => { writes++; return { status: 'SUBMITTED' }; }
  }) });
  const request = { planId: preview.id, storeId: state.storeId, items: state.task.plan.items };
  return { registry, request, state, writes: () => writes };
}

test('price capability requires the exact current synthetic execution context', () => {
  const valid = setup(); assert.equal(valid.registry.invoke('demo.price.write', valid.request).status, 'SUBMITTED');
  assert.equal(valid.writes(), 1);
  for (const corrupt of [s => { s.task.approval = null; }, s => { s.task.status = 'VERIFIED'; },
    s => { s.action.authorizationEvidenceId = 'different'; }, s => { s.action.platformId = 'production'; },
    s => { s.simulated = false; }, s => { s.realPlatformVerified = true; }]) {
    const candidate = setup(); corrupt(candidate.state);
    assert.throws(() => candidate.registry.invoke('demo.price.write', candidate.request, { approved: true }));
    assert.equal(candidate.writes(), 0);
  }
});

test('changing target, value, plan or store cannot reuse the saved approval', () => {
  for (const corrupt of [r => { r.storeId = 'other'; }, r => { r.planId = 'stale'; },
    r => { r.items[0].value = 1; }, r => { r.items[0].targetId = 'other'; }]) {
    const candidate = setup(); const request = structuredClone(candidate.request); corrupt(request);
    assert.throws(() => candidate.registry.invoke('demo.price.write', request));
    assert.equal(candidate.writes(), 0);
  }
});
