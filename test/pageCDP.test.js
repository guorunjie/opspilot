import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openPageCDP } from '../src/rpa/pageCDP.js';
import { createPageEvidence } from '../src/evidence/pageEvidence.js';
const scope = { namespace: 'demo', taskId: 't', planId: 'p', runId: 'r', connectorId: 'c', storeId: 's' };
function fixture(nodes = [2]) {
  const methods = []; let detached = 0;
  const context = { newCDPSession: async () => ({ send: async method => {
    methods.push(method);
    return { 'DOM.getDocument': { root: { nodeId: 1 } }, 'DOM.querySelectorAll': { nodeIds: nodes },
      'DOM.getOuterHTML': { outerHTML: '<output>1800</output>' },
      'Page.captureScreenshot': { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') } }[method];
  }, detach: async () => { detached++; } }) };
  return { context, page: { context: () => context, isClosed: () => false }, methods, get detached() { return detached; } };
}
test('DOM capture binds copied scope and bytes without a verified claim', async () => {
  const f = fixture(); const input = { ...scope }; const adapter = await openPageCDP({ ...f, scope: input, simulated: true }); input.runId = 'changed';
  const result = await adapter.readDOM('output');
  assert.equal(result.status, 'CAPTURED'); assert.equal(result.artifact.record.scope.runId, 'r');
  assert.equal(result.artifact.record.sha256, createHash('sha256').update(result.artifact.bytes).digest('hex'));
  assert.equal(result.artifact.record.verified, undefined);
  assert.deepEqual(f.methods, ['DOM.getDocument', 'DOM.querySelectorAll', 'DOM.getOuterHTML']);
  assert.equal(adapter.send, undefined); await adapter.detach();
});
test('missing and duplicate DOM targets never produce evidence', async () => {
  for (const nodes of [[], [2, 3]]) {
    const f = fixture(nodes); const adapter = await openPageCDP({ ...f, scope, simulated: true });
    const result = await adapter.readDOM('output'); assert.equal(result.artifact, null);
    assert.equal(result.status, nodes.length ? 'AMBIGUOUS' : 'MISSING'); await adapter.detach();
  }
});
test('screenshot and detach are scoped; detached adapter cannot capture', async () => {
  const f = fixture(); const adapter = await openPageCDP({ ...f, scope, simulated: true });
  assert.equal((await adapter.screenshot()).record.mediaType, 'image/png');
  await adapter.detach(); await adapter.detach(); assert.equal(f.detached, 1);
  await assert.rejects(adapter.screenshot(), /unavailable/);
});
test('incomplete evidence and unrelated page context fail closed', async () => {
  assert.throws(() => createPageEvidence({ scope: {}, kind: 'dom', bytes: Buffer.from('x'), simulated: true }));
  assert.throws(() => createPageEvidence({ scope, kind: 'dom', bytes: Buffer.alloc(0), simulated: true }));
  const f = fixture(); await assert.rejects(openPageCDP({ ...f, context: {}, scope, simulated: true }));
});
