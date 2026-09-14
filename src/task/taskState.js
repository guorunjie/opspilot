import { isDeepStrictEqual } from 'node:util';
import { verifyTargetState } from '../verification/verifyTargetState.js';

export const TASK_STATES = Object.freeze(['NOT_CHECKED', 'MISSING_DATA', 'READY',
  'AWAITING_APPROVAL', 'EXECUTING', 'SUBMITTED', 'VERIFYING', 'VERIFIED',
  'PARTIALLY_VERIFIED', 'FAILED', 'ROLLED_BACK', 'UNKNOWN']);
const require = (condition, message) => { if (!condition) throw new Error(`Task: ${message}`); };
const id = value => typeof value === 'string' && value.trim().length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function createTask({ id: taskId, namespace, connectorId, storeId }) {
  require([taskId, namespace, connectorId, storeId].every(id), 'scope is required');
  return { kind: 'Task', version: 1, id: taskId, namespace, connectorId, storeId,
    status: 'NOT_CHECKED', plan: null, approval: null, run: null,
    verifications: [], history: [] };
}

function reduce(task, event) {
  require(event && typeof event === 'object' && !Array.isArray(event), 'event required');
  require(typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)), 'event time required');
  const state = structuredClone(task);
  const from = (...states) => require(states.includes(state.status), `cannot ${event.type} from ${state.status}`);
  switch (event.type) {
    case 'CHECK':
      from('NOT_CHECKED', 'MISSING_DATA', 'READY');
      require(typeof event.ready === 'boolean', 'check result required');
      state.status = event.ready ? 'READY' : 'MISSING_DATA';
      break;
    case 'PLAN': {
      from('READY', 'AWAITING_APPROVAL');
      require(!state.approval, 'approved plan cannot change');
      const plan = event.plan;
      require(id(plan?.id) && Array.isArray(plan.items) && plan.items.length > 0
        && Array.from(plan.items).every(item => id(item?.targetId) && integer(item.before) && integer(item.value))
        && new Set(plan.items.map(item => item.targetId)).size === plan.items.length, 'invalid plan');
      require(!state.history.some(item => item.type === 'PLAN' && item.plan.id === plan.id), 'plan identifiers cannot be reused');
      state.plan = structuredClone(plan);
      state.status = 'AWAITING_APPROVAL';
      break;
    }
    case 'APPROVE':
      from('AWAITING_APPROVAL');
      require(!state.approval && event.confirmed === true && event.planId === state.plan.id, 'explicit current approval required');
      state.approval = { planId: event.planId, at: event.at };
      break;
    case 'START':
      from('AWAITING_APPROVAL');
      require(state.approval?.planId === state.plan.id && !state.run && id(event.runId), 'approval and new run required');
      state.run = { id: event.runId, idempotencyKey: state.plan.id, startedAt: event.at };
      state.status = 'EXECUTING';
      break;
    case 'SUBMIT':
      from('EXECUTING');
      require(typeof event.uncertain === 'boolean', 'submission certainty required');
      state.status = event.uncertain ? 'UNKNOWN' : 'SUBMITTED';
      break;
    case 'BEGIN_VERIFY':
      from('SUBMITTED', 'UNKNOWN', 'PARTIALLY_VERIFIED', 'FAILED');
      require(state.run !== null, 'execution run required');
      require(!state.verifications.some(item => item.purpose === 'rollback'), 'continue rollback reconciliation, not forward verification');
      state.status = 'VERIFYING';
      break;
    case 'READBACK': {
      from('VERIFYING');
      const result = verifyTargetState({ planId: state.plan.id, connectorId: state.connectorId,
        storeId: state.storeId, expected: state.plan.items, readback: event.readback });
      state.verifications.push({ runId: state.run.id, at: event.at, ...result });
      state.status = result.status;
      break;
    }
    case 'INTERRUPT':
      from('EXECUTING', 'VERIFYING');
      state.status = 'UNKNOWN';
      break;
    // Rollback is a separately authorized connector operation. This event only
    // checks its returned original target values; it never performs a write.
    case 'ROLLBACK_READBACK': {
      from('VERIFIED', 'PARTIALLY_VERIFIED', 'FAILED', 'UNKNOWN');
      require(state.run && event.confirmed === true && event.planId === state.plan.id, 'rollback confirmation required');
      const result = verifyTargetState({ planId: state.plan.id, connectorId: state.connectorId,
        storeId: state.storeId, expected: state.plan.items.map(item => ({ targetId: item.targetId, value: item.before })), readback: event.readback });
      state.verifications.push({ runId: state.run.id, at: event.at, purpose: 'rollback', ...result });
      state.status = result.exact ? 'ROLLED_BACK' : 'UNKNOWN';
      break;
    }
    default: throw new Error('Task: unknown event');
  }
  state.history.push(structuredClone(event));
  return state;
}

// Replay checks consistency, not authenticity: local journals are unsigned.
// Runtime owns approval provenance and connector retrieval, never model text.
export function assertTask(task) {
  require(task?.kind === 'Task' && task.version === 1 && Array.isArray(task.history), 'invalid record');
  let replayed = createTask(task);
  for (const event of task.history) replayed = reduce(replayed, event);
  require(isDeepStrictEqual(task, replayed), 'saved state differs from event history');
  return task;
}

export function advanceTask(task, event) {
  assertTask(task);
  return reduce(task, { ...structuredClone(event), at: event?.at ?? new Date().toISOString() });
}
