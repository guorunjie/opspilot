import { isDeepStrictEqual } from 'node:util';
import { CapabilityRegistry } from '../capability/capabilityRegistry.js';
import { assertTask } from '../task/taskState.js';
import { assertPlatformAction } from '../domain/model/platformActionProtocol.js';

// Composition root owns these closures; neither planner output nor IPC can
// supply an authorizer or switch connectors. Only synthetic price operations.
export function createDemoPriceCapabilities({ getConnector, getState }) {
  const matches = request => {
    const state = getState();
    return state.mode === 'offline_demo' && state.simulated === true && state.realPlatformVerified === false
      && state.preview?.id === request?.planId && request.storeId === state.storeId
      && isDeepStrictEqual(request.items, state.preview.items.map(item => ({ targetId: item.productId, before: item.before, value: item.after })));
  };
  const authorize = request => {
    if (!matches(request)) return false;
    const state = getState();
    assertPlatformAction(state.action);
    if (state.action.status !== 'running' || state.action.actionType !== 'update_prices'
      || state.action.platformId !== 'offline_demo' || state.action.storeId !== request.storeId
      || state.action.authorizationLevel !== 'B'
      || state.action.authorizationEvidenceId !== `demo-only:${request.planId}`
      || state.action.idempotencyKey !== request.planId
      || !isDeepStrictEqual(state.action.immutableManifest, state.preview)) return false;
    if (state.task) {
      assertTask(state.task);
      return state.task.status === 'EXECUTING' && state.task.namespace === 'offline_demo'
        && state.task.connectorId === 'offline_demo' && state.task.storeId === request.storeId
        && state.task.approval?.planId === request.planId && state.task.run?.idempotencyKey === request.planId
        && state.task.plan.id === request.planId && isDeepStrictEqual(state.task.plan.items, request.items);
    }
    return true; // Validated legacy v1 authorization, not newly invented consent.
  };
  return new CapabilityRegistry([
    { id: 'demo.price.write', riskLevel: 'simulated_write',
      preconditions: request => matches(request) && getConnector().checkWrite(request), authorize,
      run: request => getConnector().apply(request, { mismatch: getState().executionScenario === 'mismatch' }) },
    { id: 'demo.price.read', riskLevel: 'readonly',
      preconditions: request => matches(request) && getState().action?.status === 'awaiting_readback'
        && (!getState().task || getState().task.status === 'VERIFYING'),
      run: request => getState().executionScenario === 'readback_unavailable' && getState().readbackAttempts.length === 0
        ? null : getConnector().read(request) }
  ]);
}
