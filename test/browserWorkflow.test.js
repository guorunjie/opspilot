import test from 'node:test';
import assert from 'node:assert/strict';
import { compileBrowserWorkflow, runBrowserWorkflow } from '../src/rpa/browserWorkflow.js';
const workflow = { version: 1, id: 'price', steps: [{ id: 'submit', type: 'click', selector: '#submit' }] };
function fixture(options = {}) {
  let clicks = 0;
  return { runtime: { snapshot: () => ({ offline: true }), run: async fn => fn({ locator: () => ({
    count: async () => options.count ?? 1, textContent: async () => options.text ?? '1800',
    click: async () => { clicks++; if (options.failClick) throw new Error('lost response'); }, fill: async () => {}
  }) }) }, get clicks() { return clicks; } };
}
const gates = { preconditions: async () => true, authorize: async () => true };
test('strict schema excludes arbitrary code, loops, duplicate IDs, sparse steps and unknown keys', () => {
  for (const bad of [{ ...workflow, script: 'x' }, { ...workflow, steps: [{ id: 'a', type: 'eval', selector: 'x' }] },
    { ...workflow, steps: [workflow.steps[0], workflow.steps[0]] }, { ...workflow, steps: Array(1) }])
    assert.throws(() => compileBrowserWorkflow(bad));
  const compiled = compileBrowserWorkflow(workflow); assert.equal(compiled.riskLevel, 'simulated_write');
  assert.ok(Object.isFrozen(compiled.definition.steps[0]));
});
test('unauthorized or ambiguous target never clicks', async () => {
  for (const opts of [{ allow: false }, { count: 0 }, { count: 2 }]) {
    const f = fixture(opts);
    await assert.rejects(runBrowserWorkflow({ ...f, workflow, ...gates, authorize: () => opts.allow !== false }), e => e.mutationState === 'not_started');
    assert.equal(f.clicks, 0);
  }
});
test('completed workflow is not VERIFIED and steps are journaled around invocation', async () => {
  const f = fixture(); const events = [];
  const result = await runBrowserWorkflow({ ...f, workflow, ...gates, onStep: e => { events.push([e.phase, f.clicks]); } });
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.verified, undefined);
  assert.deepEqual(events, [['STARTED', 0], ['COMPLETED', 1]]);
});
test('write or post-write journal failure never retries', async () => {
  for (const failClick of [true, false]) {
    const f = fixture({ failClick });
    await assert.rejects(runBrowserWorkflow({ ...f, workflow, ...gates, onStep: e => {
      if (!failClick && e.phase === 'COMPLETED') throw new Error('journal failed');
    } }), e => e.mutationState === 'possibly_started');
    assert.equal(f.clicks, 1);
  }
});
test('revocation while checkpointing prevents the write', async () => {
  const f = fixture(); let approved = true;
  await assert.rejects(runBrowserWorkflow({ ...f, workflow, ...gates, authorize: () => approved, onStep: () => { approved = false; } }));
  assert.equal(f.clicks, 0);
});
test('read workflow needs no write authorization and preserves text instead of inventing zero', async () => {
  const f = fixture({ text: '' });
  const result = await runBrowserWorkflow({ ...f, workflow: { version: 1, id: 'read', steps: [{ id: 'value', type: 'readText', selector: '#value' }] }, preconditions: () => true });
  assert.deepEqual(result.outputs, [{ stepId: 'value', value: '' }]); assert.equal(f.clicks, 0);
});
