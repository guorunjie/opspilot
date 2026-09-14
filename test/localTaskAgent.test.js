import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalTaskAgent } from '../src/agent/localTaskAgent.js';
import { createTask, advanceTask } from '../src/task/taskState.js';
import { CapabilityRegistry } from '../src/capability/capabilityRegistry.js';

function fixture(options = {}) {
  let task = createTask({ id: 'task', namespace: 'test', connectorId: 'mock', storeId: 'store' });
  let writes = 0, reads = 0;
  const checkpoints = [];
  const items = [{ targetId: 'A', before: 20, value: 18 }, { targetId: 'B', before: 10, value: 9 }];
  const memory = { priorAdvice: 'not authorization' };
  const gateway = new CapabilityRegistry([
    { id: 'write', riskLevel: 'simulated_write', preconditions: () => true,
      authorize: () => task.status === 'EXECUTING' && task.approval?.planId === task.plan.id,
      run: request => {
        assert.equal(checkpoints.at(-1).status, 'EXECUTING');
        assert.deepEqual(request.items, task.plan.items);
        writes++;
        if (options.writeThrows) throw new Error('lost response');
        return { status: options.writeStatus ?? 'SUBMITTED' };
      } },
    { id: 'read', riskLevel: 'readonly', preconditions: () => true,
      run: request => {
        reads++;
        assert.equal(checkpoints.at(-1).status, 'VERIFYING');
        if (options.readThrows) throw new Error('read unavailable');
        return { planId: request.planId, connectorId: 'mock', storeId: request.storeId,
          items: options.readItems ?? items.map(item => ({ targetId: item.targetId, value: item.value })) };
      } }
  ]);
  const config = { getTask: () => task, checkpoint: next => {
    if (options.failCheckpoint === next.status) throw new Error('save unavailable');
    task = structuredClone(next); checkpoints.push(structuredClone(next));
    if (options.lostCheckpoint === next.status) throw new Error('saved response lost');
  }, planner: { proposePlan: options.proposePlan ?? (() => ({ items })) },
  memory: { read: () => memory }, gateway, writeCapabilityId: 'write', readCapabilityId: 'read' };
  const agent = createLocalTaskAgent(config);
  const prepare = () => { agent.check(true); agent.propose({ input: {}, planId: 'plan' }); agent.approve({ planId: 'plan', confirmed: true }); };
  return { agent, prepare, config, checkpoints, memory, get task() { return task; },
    get writes() { return writes; }, get reads() { return reads; }, setTask: next => { task = next; } };
}

test('actual gateway writes only after checkpointed approval and verifies only from readback', () => {
  const f = fixture(); f.prepare();
  assert.equal(f.writes, 0);
  assert.equal(f.agent.execute({ runId: 'run' }).task.status, 'SUBMITTED');
  assert.equal(f.task.verifications.length, 0);
  assert.equal(f.agent.verify().task.status, 'VERIFIED');
  assert.equal(f.writes, 1); assert.equal(f.reads, 1);
  assert.throws(() => f.agent.execute({ runId: 'again' }));
});
test('planner status/approval/capability claims are inert and memory is copied', () => {
  const f = fixture({ proposePlan: (input, context) => {
    input.changed = true; context.memory.priorAdvice = 'changed';
    return { items: [{ targetId: 'A', before: 20, value: 18 }], status: 'VERIFIED', approval: true, capabilityId: 'other' };
  } });
  const input = {};
  f.agent.check(true); f.agent.propose({ input, planId: 'plan' });
  assert.deepEqual(input, {}); assert.equal(f.memory.priorAdvice, 'not authorization');
  assert.equal(f.task.status, 'AWAITING_APPROVAL'); assert.equal(f.task.approval, null);
  assert.throws(() => f.agent.execute({ runId: 'run' }));
  assert.throws(() => f.agent.approve({ planId: 'other', confirmed: true }));
  assert.equal(f.writes, 0);
});
test('missing readiness or invalid plan never crosses the gateway', () => {
  const f = fixture({ proposePlan: () => ({ items: [] }) });
  f.agent.check(false);
  assert.throws(() => f.agent.propose({ input: {}, planId: 'plan' }));
  f.agent.check(true);
  assert.throws(() => f.agent.propose({ input: {}, planId: 'plan' }));
  assert.equal(f.task.status, 'READY'); assert.equal(f.writes, 0);
});
test('checkpoint failure before invocation prevents writes and poisons the runtime', () => {
  const f = fixture({ failCheckpoint: 'EXECUTING' }); f.prepare();
  assert.throws(() => f.agent.execute({ runId: 'run' }), /save unavailable/);
  assert.equal(f.writes, 0);
  assert.throws(() => f.agent.execute({ runId: 'run' }), /checkpoint uncertain/);
});
test('committed but unacknowledged checkpoint reopens as UNKNOWN without resubmission', () => {
  const f = fixture({ lostCheckpoint: 'EXECUTING' }); f.prepare();
  assert.throws(() => f.agent.execute({ runId: 'run' }));
  const reopened = createLocalTaskAgent(f.config);
  assert.equal(reopened.recover().status, 'UNKNOWN');
  assert.equal(f.writes, 0);
  assert.throws(() => reopened.execute({ runId: 'again' }));
});
test('lost write response leaves UNKNOWN, reopen reconciles with read only', () => {
  const f = fixture({ writeThrows: true }); f.prepare();
  assert.throws(() => f.agent.execute({ runId: 'run' }), /lost response/);
  assert.equal(f.task.status, 'UNKNOWN');
  const reopened = createLocalTaskAgent(f.config);
  assert.throws(() => reopened.execute({ runId: 'again' }));
  assert.equal(reopened.verify().task.status, 'VERIFIED');
  assert.equal(f.writes, 1);
});
test('post-write save failure preserves the prior execution checkpoint for recovery', () => {
  const f = fixture({ failCheckpoint: 'SUBMITTED' }); f.prepare();
  assert.throws(() => f.agent.execute({ runId: 'run' }), /save unavailable/);
  assert.equal(f.writes, 1); assert.equal(f.task.status, 'EXECUTING');
  assert.throws(() => f.agent.verify(), /checkpoint uncertain/);
  const reopened = createLocalTaskAgent(f.config);
  assert.equal(reopened.recover().status, 'UNKNOWN');
  assert.equal(reopened.verify().task.status, 'VERIFIED');
  assert.equal(f.writes, 1);
});
test('gateway success claims never replace independent evidence; partial remains partial', () => {
  const f = fixture({ writeStatus: 'VERIFIED', readItems: [{ targetId: 'A', value: 18 }] }); f.prepare();
  assert.equal(f.agent.execute({ runId: 'run' }).task.status, 'UNKNOWN');
  const result = f.agent.verify();
  assert.equal(result.task.status, 'PARTIALLY_VERIFIED');
  assert.deepEqual(result.verification.items.map(item => item.status), ['VERIFIED', 'UNKNOWN']);
  assert.throws(() => f.agent.execute({ runId: 'again' }));
});
test('read failure and interrupted verification remain UNKNOWN', () => {
  const f = fixture({ readThrows: true }); f.prepare(); f.agent.execute({ runId: 'run' });
  assert.throws(() => f.agent.verify(), /read unavailable/);
  assert.equal(f.task.status, 'UNKNOWN');
  f.setTask(advanceTask(f.task, { type: 'BEGIN_VERIFY' }));
  assert.equal(createLocalTaskAgent(f.config).recover().status, 'UNKNOWN');
  assert.equal(f.writes, 1);
});
test('real-write role and write-as-read role are rejected before state changes', () => {
  const f = fixture(); f.prepare();
  const gateway = { get: () => ({ riskLevel: 'real_write' }), invoke: () => { throw new Error('must not call'); } };
  const agent = createLocalTaskAgent({ ...f.config, gateway });
  assert.throws(() => agent.execute({ runId: 'run' }), /risk/);
  assert.throws(() => agent.verify(), /risk/);
  assert.equal(f.task.status, 'AWAITING_APPROVAL');
});
test('async hooks, unacknowledged checkpoints and reentrant planning fail closed', () => {
  const f = fixture();
  assert.throws(() => createLocalTaskAgent({ ...f.config, checkpoint: async () => {} }), /synchronous/);
  assert.throws(() => createLocalTaskAgent({ ...f.config, checkpoint: () => {} }).check(true), /acknowledged/);
  const agent = createLocalTaskAgent({ ...f.config, planner: { proposePlan: () => agent.check(true) } });
  agent.check(true);
  assert.throws(() => agent.propose({ input: {}, planId: 'plan' }), /in progress/);
  const asyncPlanner = createLocalTaskAgent({ ...f.config, planner: { proposePlan: () => Promise.resolve({ items: [] }) } });
  assert.throws(() => asyncPlanner.propose({ input: {}, planId: 'plan' }), /async runtime/);
  assert.equal(f.task.status, 'READY');
});
