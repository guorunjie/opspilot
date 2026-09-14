import { isDeepStrictEqual as equal } from 'node:util';
import { assertPlatformAction } from '../domain/model/platformActionProtocol.js';
import { verifyTargetState } from '../verification/verifyTargetState.js';
import { assertTask } from '../task/taskState.js';
import { planPrices, diagnoseProducts } from '../domain/model/pricePlanning.js';
import { validateSupplemental } from './supplementalOpportunities.js';

// Validate this version's synthetic checkpoint, not arbitrary production state.
export function validateDemoState(state, initialProducts, prices) {
  const require = condition => { if (!condition) throw new Error('演示存档不一致；保留原记录，禁止自动重跑。'); };
  if (Object.hasOwn(state, 'supplemental')) {
    require(state.task && state.diagnosis && state.supplemental && typeof state.supplemental === 'object' && !Array.isArray(state.supplemental));
    const kinds = Object.keys(state.supplemental);
    require(kinds.length > 0 && kinds.every(kind => ['inventory', 'campaign'].includes(kind)));
    for (const kind of kinds) validateSupplemental(state.supplemental[kind], state.sessionId, kind);
  }
  if (state.task) {
    assertTask(state.task);
    const task = state.task;
    require(task.id === state.sessionId && task.namespace === 'offline_demo'
      && task.connectorId === 'offline_demo' && task.storeId === state.storeId);
    require(equal(task.plan, state.preview ? { id: state.preview.id,
      items: state.preview.items.map(item => ({ targetId: item.productId, before: item.before, value: item.after })) } : null));
    require(Boolean(task.approval) === Boolean(state.action));
    require(Boolean(task.run) === (state.submissionCount === 1));
    const expectedStatus = !state.diagnosis ? 'NOT_CHECKED' : !state.preview ? 'READY'
      : !state.submissionCount ? 'AWAITING_APPROVAL'
      : state.action?.status === 'succeeded' ? 'VERIFIED'
      : state.action?.status === 'readback_inconsistent' ? 'FAILED'
      : state.executionScenario === 'response_lost' || state.readbackAttempts?.at(-1)?.status === 'UNKNOWN' ? 'UNKNOWN' : 'SUBMITTED';
    require(task.status === expectedStatus);
    require(task.verifications.length === (state.readbackAttempts?.length ?? 0));
    if (state.review) require(equal(task.verifications.at(-1)?.items, state.review.items.map(item => ({ targetId: item.productId,
      expected: item.expected, observed: item.observed, status: item.matched ? 'VERIFIED' : 'FAILED' }))));
  }
  require(equal(state.products, initialProducts));
  if (state.diagnosis && Object.hasOwn(state.diagnosis, 'ruleVersion')) {
    require(state.diagnosis.ruleVersion === 1);
    for (const [key, value] of Object.entries(diagnoseProducts(initialProducts))) require(equal(state.diagnosis[key], value));
  }
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
    const plan = planPrices(initialProducts, { minimumMargin: 0.2 });
    require(equal(state.preview.items, plan.items));
    require(equal(state.preview.excluded, plan.excluded));
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
  const scope = { planId: state.preview.id, connectorId: 'offline_demo', storeId: state.storeId };
  const verification = verifyTargetState({ ...scope,
    expected: state.preview.items.map(p => ({ targetId: p.productId, value: p.after })),
    readback: { ...scope, items: state.preview.items.map(p => ({ targetId: p.productId, value: prices.get(p.productId) })) }
  });
  const items = verification.items.map(p => ({ productId: p.targetId, expected: p.expected,
    observed: p.observed, matched: p.status === 'VERIFIED' }));
  const matchedCount = items.filter(p => p.matched).length;
  require(equal(state.review, { simulated: true, realPlatformVerified: false, items, matchedCount, actualProfitImpact: null }));
  require(equal(action.evidence, { exact: matchedCount === items.length, simulated: true, realPlatformVerified: false, items }));
  require((action.status === 'succeeded') === (matchedCount === items.length));
  require(action.terminal === (action.status === 'succeeded'));
  require(action.history.at(-1)?.to === action.status);
  if (action.status === 'succeeded') require(action.history.at(-2)?.to === 'readback_consistent');
}
