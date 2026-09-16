import { createHash } from 'node:crypto';
import { buildSourceOpportunities } from '../domain/model/sourceOpportunities.js';
import { createTask, advanceTask } from './taskState.js';

function assertIdent(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 128
    || /[\u0000-\u001f\u007f]/.test(value))
    throw new TypeError(`${name} must be a trimmed identifier of at most 128 characters`);
  return value;
}

function selectPlanItem({ productId, kind, proposal }) {
  if (kind === 'pricing') return { targetId: productId, before: proposal.before, value: proposal.after };
  if (kind === 'inventory') return { targetId: `inventory:${productId}`, before: proposal.before, value: proposal.value };
  if (kind === 'campaign') {
    const offerKey = createHash('sha256')
      .update(JSON.stringify([productId, proposal.campaignId, proposal.campaignPrice])).digest('hex');
    return { targetId: `campaign:${offerKey}`, before: proposal.before, value: proposal.value };
  }
  throw new TypeError('Unsupported opportunity kind');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// DS056 draft corrected against the existing reducer. Preview only: evidence
// records provenance/consistency, not authenticity or execution authorization.
export function prepareSourceOpportunityTask({ input, options, opportunityId, taskId, planId, namespace } = {}) {
  for (const [name, value] of Object.entries({ opportunityId, taskId, planId, namespace })) assertIdent(value, name);
  const { observation, opportunities } = buildSourceOpportunities(input, options);
  if (observation.status !== 'READY')
    return deepFreeze({ status: 'UNKNOWN', reason: observation.reason, task: null });
  const selected = opportunities.find(candidate => candidate.id === opportunityId);
  if (!selected) return deepFreeze({ status: 'UNKNOWN', reason: 'opportunity_not_current', task: null });
  if (selected.kind === 'data_quality')
    return deepFreeze({ status: 'UNSUPPORTED', reason: 'data_quality_requires_source_correction', task: null });
  const at = options.now;
  let task = createTask({ id: taskId, namespace, connectorId: observation.sourceId, storeId: observation.storeId });
  task = advanceTask(task, { type: 'CHECK', at, ready: true });
  task = advanceTask(task, { type: 'PLAN', at, plan: {
    id: planId, items: [selectPlanItem(selected)],
    sourceEvidence: { observation: structuredClone(observation), opportunity: structuredClone(selected) }
  } });
  return deepFreeze({ status: 'AWAITING_APPROVAL', reason: 'separate_approval_required', task });
}
