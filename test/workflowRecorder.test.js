import test from 'node:test';
import assert from 'node:assert/strict';
import { compileBrowserWorkflow } from '../src/rpa/browserWorkflow.js';
import { workflowFromRecording, startWorkflowRecorder } from '../src/rpa/workflowRecorder.js';
const compiled = compileBrowserWorkflow({ version: 1, id: 'recorded', steps: [{ id: 'one', type: 'click', selector: '#submit' }] });
const record = { kind: 'WorkflowRecording', version: 1, simulated: true, definition: compiled.definition, digest: compiled.digest,
  startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z' };
test('validated recording imports only a workflow definition, never authorization', () => {
  assert.deepEqual(workflowFromRecording(record), compiled.definition);
  assert.throws(() => workflowFromRecording({ ...record, approval: true }));
  assert.throws(() => workflowFromRecording({ ...record, simulated: false }));
});
test('changed definition, invalid time, and injected script are rejected', () => {
  assert.throws(() => workflowFromRecording({ ...record, digest: 'wrong' }));
  assert.throws(() => workflowFromRecording({ ...record, endedAt: 'invalid' }));
  assert.throws(() => workflowFromRecording({ ...record, startedAt: 1 }));
  assert.throws(() => workflowFromRecording({ ...record, endedAt: '2025-01-01T00:00:00Z' }));
  assert.throws(() => workflowFromRecording({ ...record, definition: { ...record.definition, script: 'bad' } }));
});
test('recorder refuses missing offline runtime and broad implicit control capture', async () => {
  await assert.rejects(startWorkflowRecorder({ workflowId: 'x', controls: [] }));
  const runtime = { page: { isClosed: () => false }, snapshot: () => ({ offline: true }) };
  await assert.rejects(startWorkflowRecorder({ runtime, workflowId: 'x', controls: [{ type: 'fill', selector: '#x', any: true }] }));
});
