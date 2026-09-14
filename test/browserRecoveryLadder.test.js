import test from 'node:test';
import assert from 'node:assert/strict';
import { runBrowserRecoveryLadder } from '../src/rpa/browserRecoveryLadder.js';
const missing = () => { throw Object.assign(new Error('selector missing'), { mutationState: 'not_started' }); };
const base = { operation: missing, executeRecoveredLocator: async candidate => candidate, context: { operationType: 'read' } };

test('explicit not-started failures may use fixed then semantic locator recovery', async () => {
  const result = await runBrowserRecoveryLadder({ ...base, playwrightFallback: async () => 'found' });
  assert.equal(result.recoveredBy, 'playwright'); assert.equal(result.value, 'found');
});
test('missing, invalid and possible mutation knowledge stop before any fallback', async () => {
  for (const state of [undefined, 'invalid', 'possibly_started', 'confirmed_started']) {
    let calls = 0;
    await assert.rejects(runBrowserRecoveryLadder({ ...base,
      operation: () => { throw Object.assign(new Error('timeout'), { mutationState: state }); },
      playwrightFallback: () => { calls++; } }), e => e.requiresReadbackOnly === true);
    assert.equal(calls, 0);
  }
});
test('successful operation followed by sync or async audit failure is never replayed', async () => {
  for (const audit of [() => { throw new Error('audit failed'); }, async () => { throw new Error('audit failed'); }]) {
    let actions = 0, fallbacks = 0;
    await assert.rejects(runBrowserRecoveryLadder({ ...base, operation: () => { actions++; return 'submitted'; },
      playwrightFallback: () => { fallbacks++; }, audit }), { code: 'browser_recovery_audit_failed' });
    assert.equal(actions, 1); assert.equal(fallbacks, 0);
  }
});
test('AI candidates require explicit validator and cannot gain approval from mutation', async () => {
  let executions = 0;
  const config = { ...base, agentBrowserRelocator: async () => ({ selector: '#safe' }), executeRecoveredLocator: async c => { executions++; return c.selector; } };
  await assert.rejects(runBrowserRecoveryLadder(config), { code: 'browser_recovery_ladder_exhausted' });
  assert.equal(executions, 0);
  const result = await runBrowserRecoveryLadder({ ...config, validateRecoveredLocator: async candidate => { candidate.selector = '#changed'; return true; } });
  assert.equal(result.value, '#safe'); assert.equal(executions, 1);
});
test('final simulated submit cannot fall back to AI relocation', async () => {
  let relocated = 0;
  await assert.rejects(runBrowserRecoveryLadder({ ...base,
    context: { operationType: 'write', simulation: true, finalSubmission: true, approved: true, approvalId: 'p', expectedIdentity: 'sku' },
    agentBrowserRelocator: () => { relocated++; } }), { code: 'browser_recovery_ai_forbidden_for_final_submission' });
  assert.equal(relocated, 0);
});
test('real writes, implicit operation type, and unapproved simulations are rejected before execution', async () => {
  for (const context of [{}, { operationType: 'write' }, { operationType: 'write', simulation: true }]) {
    let calls = 0;
    await assert.rejects(runBrowserRecoveryLadder({ ...base, context, operation: () => { calls++; } }));
    assert.equal(calls, 0);
  }
});
test('operation completion does not claim target verification or no mutation', async () => {
  const result = await runBrowserRecoveryLadder({ ...base, operation: async () => ({ status: 'SUBMITTED' }) });
  assert.equal(result.status, 'completed'); assert.equal(result.value.status, 'SUBMITTED');
  assert.equal(result.attempts[0].mutationState, 'possibly_started');
  assert.equal(result.verified, undefined);
});
