import { isDeepStrictEqual as equal } from 'node:util';
import { assertPlatformAction } from '../domain/model/platformActionProtocol.js';

// Validate this version's synthetic checkpoint, not arbitrary production state.
export function validateDemoState(state, initialProducts, prices) {
  const require = condition => { if (!condition) throw new Error('演示存档不一致；保留原记录，禁止自动重跑。'); };
  require(equal(state.products, initialProducts));
  require(typeof state.sessionId === 'string' && state.sessionId.length > 0);
  require(state.submissionCount === 0 || state.submissionCount === 1);
  // Older unpublished checkpoints did not record a scenario: keep it unknown.
  require(state.executionScenario === undefined || (state.submissionCount === 0
    ? state.executionScenario === null : ['normal', 'response_lost', 'mismatch', 'readback_unavailable'].includes(state.executionScenario)));
  const attempts = state.readbackAttempts;
  // Missing field is accepted only for old checkpoints predating this scenario.
  if (attempts === undefined) require(state.executionScenario !== 'readback_unavailable');
  else {
    require(Array.isArray(attempts));
    const expected = [];
    if (state.executionScenario === 'readback_unavailable' && attempts.length > 0) {
      expected.push({ status: 'UNKNOWN', code: 'target_unavailable', simulated: true, realPlatformVerified: false });
    }
    if (['succeeded', 'readback_inconsistent'].includes(state.action?.status)) {
      const matched = state.action.status === 'succeeded';
      if (state.executionScenario === 'readback_unavailable') require(attempts.length === 2);
      expected.push({ status: matched ? 'VERIFIED' : 'MISMATCH', code: matched ? 'exact_match' : 'target_mismatch', simulated: true, realPlatformVerified: false });
    }
    require(equal(attempts, expected));
    if (attempts.length) require(state.submissionCount === 1 && state.action?.status !== 'pending');
  }
  if (state.preview) {
    require(state.diagnosis?.simulated === true);
    require(state.preview.simulated === true && state.preview.minimumMargin === 0.2);
    require(typeof state.preview.id === 'string' && state.preview.id.startsWith(`${state.sessionId}:`));
    const eligible = initialProducts.filter(p => p.target !== null && p.cost !== null && (p.target - p.cost) / p.target >= 0.2);
    require(equal(state.preview.items, eligible.map(p => ({ productId: p.id, name: p.name,
      before: p.price, after: p.target, cost: p.cost, margin: (p.target - p.cost) / p.target }))));
  }
  const action = state.action;
  if (!action) {
    require(state.submissionCount === 0 && state.review === null);
    require(initialProducts.every(p => prices.get(p.id) === p.price));
    return;
  }
  try { assertPlatformAction(action); } catch { require(false); }
  require(action.platformId === 'offline_demo' && action.storeId === state.storeId && action.storeName === state.storeName);
  require(action.actionType === 'update_prices' && action.authorizationLevel === 'B');
  require(action.metadata?.simulated === true && action.metadata?.realPlatformVerified === false);
  require(state.preview && equal(action.immutableManifest, state.preview));
  require(action.authorizationEvidenceId === `demo-only:${state.preview.id}` && action.idempotencyKey === state.preview.id);
  require(['pending', 'awaiting_readback', 'succeeded', 'readback_inconsistent'].includes(action.status));
  const submitted = action.status !== 'pending';
  require(state.submissionCount === (submitted ? 1 : 0) && action.mutationAttempted === submitted);
  if (!submitted) require(initialProducts.every(p => prices.get(p.id) === p.price));
  if (['pending', 'awaiting_readback'].includes(action.status)) {
    require(state.review === null && action.evidence === null && action.terminal === false);
    return;
  }
  const items = state.preview.items.map(p => ({ productId: p.productId, expected: p.after,
    observed: prices.get(p.productId), matched: prices.get(p.productId) === p.after }));
  const matchedCount = items.filter(p => p.matched).length;
  require(equal(state.review, { simulated: true, realPlatformVerified: false, items, matchedCount, actualProfitImpact: null }));
  require(equal(action.evidence, { exact: matchedCount === items.length, simulated: true, realPlatformVerified: false, items }));
  require((action.status === 'succeeded') === (matchedCount === items.length));
  require(action.terminal === (action.status === 'succeeded'));
  require(action.history.at(-1)?.to === action.status);
  if (action.status === 'succeeded') require(action.history.at(-2)?.to === 'readback_consistent');
}
