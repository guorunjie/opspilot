// DS061 draft corrected to actual Task scope and rejection semantics.
import test from 'node:test';
import assert from 'node:assert/strict';

test('foundation exposes only the selected public functions', async () => {
  const api = await import('opspilot/foundation');
  assert.deepEqual(Object.keys(api).sort(), [
    'AsyncCapabilityRegistry', 'advanceTask', 'compileBrowserWorkflow',
    'createConnectorWorkflowCapability', 'createSourceReader', 'createTask',
    'openPersistentTask', 'openStateStore', 'prepareCompensationPreview',
    'prepareSourceOpportunityTask', 'startWorkflowRecorder', 'workflowFromRecording'
  ].sort());
  const direct = await import('../src/connector/sourceReader.js');
  assert.equal(api.createSourceReader, direct.createSourceReader);
});

test('consumer task starts unchecked and cannot execute without approval', async () => {
  const { createTask, advanceTask } = await import('opspilot/foundation');
  const task = createTask({ id: 't', namespace: 'test', connectorId: 'example', storeId: 's' });
  assert.equal(task.status, 'NOT_CHECKED');
  assert.equal(task.approval, null);
  assert.equal(task.run, null);
  assert.throws(() => advanceTask(task, {
    type: 'START', runId: 'r', at: '2026-09-16T00:00:00.000Z'
  }));
});
