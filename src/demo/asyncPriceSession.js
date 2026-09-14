import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createAsyncTaskAgent } from '../agent/asyncTaskAgent.js';
import { AsyncCapabilityRegistry } from '../capability/asyncCapabilityRegistry.js';
import { openPersistentTask } from '../storage/persistentTask.js';
import { createTaskOwnership } from '../storage/taskOwnership.js';
import { createMockPriceConnector } from '../connector/mockPriceConnector.js';
import { createRulePricePlanner } from '../domain/model/pricePlanning.js';
import { createTask, advanceTask } from '../task/taskState.js';

// An application-owned async price slice. It does not mutate legacy Demo
// records or select a production connector from user input.
export function openAsyncPriceSession({ store, sessionId, products, create = false, executor = null }) {
  const scope = { id: sessionId, namespace: 'offline_demo', connectorId: 'offline_demo', storeId: 'demo-store' };
  createTask(scope);
  if (typeof create !== 'boolean') throw new TypeError('Explicit creation flag required');
  const fixture = structuredClone(products);
  const planner = createRulePricePlanner();
  const details = planner.proposePlan({ products: fixture, minimumMargin: 0.2 });
  if (!details.items.length) throw new Error('No eligible synthetic price targets');
  const initial = fixture.map(item => [item.id, item.price]);
  // Let the existing connector enforce unique IDs and integer target prices.
  createMockPriceConnector({ storeId: scope.storeId, prices: initial });
  const platformKey = `async-price:${sessionId}`;
  if (platformKey.length > 256) throw new TypeError('Session ID too long');
  const identity = { sessionId, products: fixture, simulated: true };
  const readPlatform = () => {
    const row = store.read(platformKey);
    if (!row || row.value?.version !== 1 || !isDeepStrictEqual(row.value.identity, identity)
      || !Number.isSafeInteger(row.revision) || row.revision < 1
      || !['normal', 'response_lost', 'mismatch', 'readback_unavailable', null].includes(row.value.scenario)
      || ![0, 1].includes(row.value.submissionCount)
      || (row.value.submissionCount === 0 ? row.value.planId !== null : typeof row.value.planId !== 'string'))
      throw new Error('Invalid async synthetic platform record');
    createMockPriceConnector({ storeId: scope.storeId, prices: row.value.prices });
    if (!isDeepStrictEqual(row.value.prices.map(item => item[0]), initial.map(item => item[0])))
      throw new Error('Synthetic platform target scope changed');
    return row;
  };
  if (!store.read(platformKey)) {
    if (store.read(`task:${sessionId}`)) throw new Error('Target record missing for existing task; do not recreate');
    if (!create) throw new Error('Async price session does not exist');
    store.save(platformKey, { version: 1, identity, prices: initial, scenario: null, submissionCount: 0, planId: null }, 0);
  }
  readPlatform();
  const task = openPersistentTask({ store, scope, create });
  const ownership = createTaskOwnership({ store, scope, executor });
  const expectedItems = details.items.map(item => ({ targetId: item.productId, before: item.before, value: item.after }));
  const matches = (request, status) => {
    const saved = task.getTask();
    return saved.status === status && saved.storeId === request.storeId
      && saved.plan?.id === request.planId && saved.approval?.planId === request.planId
      && saved.run?.idempotencyKey === request.idempotencyKey
      && isDeepStrictEqual(saved.plan.items, request.items) && isDeepStrictEqual(request.items, expectedItems);
  };
  const gateway = new AsyncCapabilityRegistry([
    { id: 'price.write', riskLevel: 'simulated_write', preconditions: request => matches(request, 'EXECUTING'),
      authorize: request => matches(request, 'EXECUTING'), validateCurrent: request => matches(request, 'EXECUTING'),
      run: async request => {
        const row = readPlatform();
        if (row.value.submissionCount !== 0) throw new Error('Synthetic submission already recorded; read back instead');
        const connector = createMockPriceConnector({ storeId: scope.storeId, prices: row.value.prices });
        connector.apply(request, { mismatch: row.value.scenario === 'mismatch' });
        // Separate durable target commit, after the Task START checkpoint.
        const value = { ...row.value, prices: connector.snapshot(), submissionCount: 1, planId: request.planId };
        const revision = store.save(platformKey, value, row.revision);
        const saved = readPlatform();
        if (saved.revision !== revision || !isDeepStrictEqual(saved.value, value)) throw new Error('Target save acknowledgement uncertain');
        return { status: row.value.scenario === 'response_lost' ? 'UNKNOWN' : 'SUBMITTED' };
      } },
    { id: 'price.read', riskLevel: 'readonly', preconditions: request => matches(request, 'VERIFYING'),
      validateCurrent: request => matches(request, 'VERIFYING'),
      run: async request => {
        const row = readPlatform();
        if (row.value.scenario === 'readback_unavailable' && task.getTask().verifications.length === 0) return null;
        return createMockPriceConnector({ storeId: scope.storeId, prices: row.value.prices }).read(request);
      } }
  ]);
  let selectedScenario = null;
  const checkpoint = (next, previous) => {
    task.checkpoint(next, previous);
    if (previous.status === 'AWAITING_APPROVAL' && next.status === 'EXECUTING') {
      // Reserve only after durable START. A crash or uncertain reservation now
      // leaves a recoverable EXECUTING task, never a stranded approved plan.
      const row = readPlatform();
      if (row.value.submissionCount !== 0 || row.value.scenario !== null || selectedScenario === null)
        throw new Error('Execution reservation conflict; reconcile instead');
      const value = { ...row.value, scenario: selectedScenario };
      const revision = store.save(platformKey, value, row.revision);
      const saved = readPlatform();
      if (saved.revision !== revision || !isDeepStrictEqual(saved.value, value)) throw new Error('Execution reservation uncertain');
    }
  };
  const agent = createAsyncTaskAgent({ ...task, checkpoint, ownership, gateway,
    planner: { proposePlan: async () => ({ items: expectedItems }) },
    writeCapabilityId: 'price.write', readCapabilityId: 'price.read' });
  return Object.freeze({
    snapshot: () => ({ task: task.getTask(), platform: structuredClone(readPlatform().value), details: structuredClone(details) }),
    check: () => agent.check(true),
    preview: () => agent.propose({ input: {}, planId: `${sessionId}:${randomUUID()}` }),
    confirm: input => agent.approve(input),
    async execute({ scenario = 'normal' } = {}) {
      if (!['normal', 'response_lost', 'mismatch', 'readback_unavailable'].includes(scenario)) throw new Error('Unknown scenario');
      const before = task.getTask();
      if (before.status !== 'AWAITING_APPROVAL' || !before.approval || before.run) throw new Error('Approved unexecuted plan required');
      const row = readPlatform();
      if (row.value.submissionCount !== 0 || row.value.scenario !== null) throw new Error('Execution already reserved; reconcile instead');
      selectedScenario = scenario;
      return agent.execute({ runId: randomUUID() });
    },
    readback: () => agent.verify(),
    recover: input => agent.recover(input),
    recoverAbandoned({ expected, confirmStopped } = {}) {
      // Trusted composition only. No gateway invocation and no renderer proof.
      const before = task.getTask();
      const token = ownership.takeOverAbandoned({ expected, confirmStopped });
      let reconciled = false;
      try {
        ownership.assertHeld(token, before);
        if (['EXECUTING', 'VERIFYING'].includes(before.status))
          task.checkpoint(advanceTask(before, { type: 'INTERRUPT' }), before);
        const result = task.getTask(); reconciled = true; return result;
      } finally { if (reconciled) ownership.release(token); }
    },
    whenIdle: () => agent.whenIdle()
  });
}
