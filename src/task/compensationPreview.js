// src/task/compensationPreview.js
import { assertTask, createTask, advanceTask } from './taskState.js';
import { verifyTargetState } from '../verification/verifyTargetState.js';
import { createConnectorManifest } from '../connector/connectorManifest.js';

const TERMINAL_RECONCILABLE = new Set([
  'VERIFIED',
  'PARTIALLY_VERIFIED',
  'FAILED',
  'UNKNOWN',
]);

const MAX_ID = 128;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function isPlainId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID) return false;
  // reject controls and any surrounding whitespace
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;
  return trimmed === value;
}

function isStrictUtcIso(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function declined(status, reason) {
  return deepFreeze({ status, reason, task: null, link: null });
}

export function prepareCompensationPreview({
  originalTask,
  manifest,
  capabilityId,
  readback,
  taskId,
  planId,
  at,
} = {}) {
  // Replay consistency: assertTask checks internal consistency, NOT authorization.
  assertTask(originalTask);

  const canonical = createConnectorManifest(manifest);
  if (canonical.id !== originalTask.connectorId) {
    throw new Error('manifest_connector_mismatch');
  }

  const capability = canonical.capabilities.find(item => item.id === capabilityId);

  if (!capability || capability.operation !== 'compensate') {
    return declined('UNSUPPORTED', 'compensation_not_declared');
  }

  if (
    !isPlainId(taskId) ||
    !isPlainId(planId) ||
    taskId === originalTask.id ||
    planId === originalTask.plan?.id ||
    !isStrictUtcIso(at)
  ) {
    throw new Error('invalid_preview_identity');
  }

  if (!originalTask.run || !originalTask.plan) {
    return declined('UNKNOWN', 'original_execution_not_reconcilable');
  }
  if (!TERMINAL_RECONCILABLE.has(originalTask.status)) {
    return declined('UNKNOWN', 'original_execution_not_reconcilable');
  }

  const previousVerifications = (originalTask.verifications ?? []).concat(
    originalTask.plan.verifications ?? []
  );
  for (const verification of previousVerifications) {
    if (verification && verification.purpose === 'rollback') {
      // Inverse preview is unsupported once a rollback has been attempted;
      // this function is not a rollback VERIFIED verdict.
      return declined('UNKNOWN', 'rollback_already_observed');
    }
  }

  const exact = verifyTargetState({
    planId: originalTask.plan.id,
    connectorId: originalTask.connectorId,
    storeId: originalTask.storeId,
    expected: originalTask.plan.items,
    readback,
  });

  if (!exact.exact) {
    // Deliberately decline rather than overwrite later, possibly-authorized changes.
    return declined('UNKNOWN', 'current_state_not_exact');
  }

  const compensationLink = {
    originalTaskId: originalTask.id,
    originalPlanId: originalTask.plan.id,
    originalRunId: originalTask.run.id,
    compensationTaskId: taskId,
    compensationPlanId: planId,
    capabilityId: capability.id,
    execution: capability.execution,
    simulated: capability.simulated,
  };

  let task = createTask({
    id: taskId,
    namespace: originalTask.namespace,
    connectorId: originalTask.connectorId,
    storeId: originalTask.storeId,
  });

  task = advanceTask(task, { type: 'CHECK', at, ready: true });
  task = advanceTask(task, {
    type: 'PLAN',
    at,
    plan: {
      id: planId,
      items: originalTask.plan.items.map((item) => ({
        targetId: item.targetId,
        before: item.value,
        value: item.before,
      })),
      compensationLink: structuredClone(compensationLink),
    },
  });

  return deepFreeze({
    status: 'AWAITING_APPROVAL',
    reason: 'separate_approval_required',
    task,
    link: compensationLink,
  });
}
