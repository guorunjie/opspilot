import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { createTask, assertTask } from '../task/taskState.js';
import { createLocalTaskAgent } from '../agent/localTaskAgent.js';
import { CapabilityRegistry } from '../capability/capabilityRegistry.js';
import { createMockValueConnector } from '../connector/mockPriceConnector.js';
import { planStockout, planCampaign } from '../domain/model/operationPlanning.js';

// Fixed, independent synthetic observations. No ERP stock or platform eligibility.
const fixtures = {
  inventory: { targetId: 'inventory:DEMO-003', before: 0, value: 12,
    title: '补齐演示商品 C 可售库存', unit: '件',
    basis: '合成可售库存为 0 件，合成仓库可用库存为 12 件；建议将模拟平台可售库存更新为 12 件。',
    limitation: '仅模拟库存同步，不代表实物补货、采购或真实库存已核对。' },
  campaign: { targetId: 'campaign:DEMO-001:offer-1800', before: 0, value: 1,
    title: '报名演示商品 A 限时活动', unit: '报名状态（0 未报名，1 已报名）',
    basis: '合成活动资格已核对；固定活动价 ¥18.00、成本 ¥10.00，预估毛利率 44.4%，高于演示门槛 20%。',
    limitation: '仅模拟固定活动报名，不修改日常标价；不代表真实活动资格、活动上线或实际收益。' }
};
const scenarios = ['normal', 'response_lost', 'mismatch', 'readback_unavailable'];
const require = condition => { if (!condition) throw new Error('附加演示任务不一致，保留存档，禁止自动重跑。'); };
const fixtureFor = kind => { require(Object.hasOwn(fixtures, kind)); return fixtures[kind]; };
const itemsFor = kind => {
  fixtureFor(kind);
  return kind === 'inventory'
    ? planStockout({ productId: 'DEMO-003', stock: 0, warehouseAvailable: 12 }).items
    : planCampaign({ productId: 'DEMO-001', campaignPrice: 1800, cost: 1000, eligible: true, enrolled: false }).items;
};
export function supplementalCatalog() { return structuredClone(fixtures); }
const reviewFor = task => task.verifications.length ? {
  status: task.status, items: task.verifications.at(-1).items,
  simulated: true, realPlatformVerified: false, actualProfitImpact: null
} : null;

export function validateSupplemental(record, sessionId, kind) {
  const fixture = fixtureFor(kind);
  require(record?.kind === kind && record.version === 1);
  const task = assertTask(record.task);
  require(task.id === `${sessionId}:${kind}` && task.namespace === 'offline_demo'
    && task.connectorId === 'offline_demo' && task.storeId === 'demo-store');
  require(task.plan && task.plan.id.startsWith(`${task.id}:`) && equal(task.plan.items, itemsFor(kind)));
  require(record.submissionCount === (task.run ? 1 : 0));
  require(task.run ? scenarios.includes(record.scenario) : record.scenario === null);
  const observed = task.run && record.scenario !== 'mismatch' ? fixture.value : fixture.before;
  require(equal(record.values, [[fixture.targetId, observed]]));
  require(equal(record.review, reviewFor(task)));
  require(['AWAITING_APPROVAL', 'SUBMITTED', 'UNKNOWN', 'VERIFIED', 'FAILED'].includes(task.status));
  let reads = 0;
  for (const event of task.history) {
    require(['CHECK', 'PLAN', 'APPROVE', 'START', 'SUBMIT', 'BEGIN_VERIFY', 'READBACK'].includes(event.type));
    if (event.type === 'CHECK') require(event.ready === true);
    if (event.type === 'PLAN') require(equal(event.plan.items, itemsFor(kind)) && event.plan.id.startsWith(`${task.id}:`));
    if (event.type === 'SUBMIT') require(event.uncertain === (record.scenario === 'response_lost'));
    if (event.type === 'READBACK') {
      const expected = record.scenario === 'readback_unavailable' && reads === 0 ? null : {
        planId: task.plan.id, connectorId: task.connectorId, storeId: task.storeId,
        items: [{ targetId: fixture.targetId, value: observed }]
      };
      require(equal(event.readback, expected));
      reads++;
    }
  }
  require(reads <= (record.scenario === 'readback_unavailable' ? 2 : 1));
  return record;
}

// A command returns the whole task + mock target for the parent's single SQLite
// transaction. Nothing can affect a target outside this returned local record.
export function runSupplemental({ sessionId, kind, record, operation, planId, confirmed, scenario = 'normal' }) {
  const fixture = fixtureFor(kind);
  require(['preview', 'confirm', 'execute', 'readback'].includes(operation));
  if (record) validateSupplemental(record, sessionId, kind);
  else require(operation === 'preview');
  let next = record ? structuredClone(record) : { kind, version: 1,
    task: createTask({ id: `${sessionId}:${kind}`, namespace: 'offline_demo', connectorId: 'offline_demo', storeId: 'demo-store' }),
    values: [[fixture.targetId, fixture.before]], submissionCount: 0, scenario: null, review: null };
  const connector = createMockValueConnector({ storeId: 'demo-store', values: next.values });
  const matches = request => request?.planId === next.task.plan?.id && request.storeId === next.task.storeId
    && equal(request.items, next.task.plan.items) && equal(request.items, itemsFor(kind));
  const gateway = new CapabilityRegistry([
    { id: 'supplement.write', riskLevel: 'simulated_write',
      preconditions: request => matches(request) && connector.checkWrite(request),
      authorize: () => next.task.status === 'EXECUTING' && next.task.approval?.planId === next.task.plan.id,
      run: request => connector.apply(request, { mismatch: next.scenario === 'mismatch' }) },
    { id: 'supplement.read', riskLevel: 'readonly',
      preconditions: request => matches(request) && next.task.status === 'VERIFYING',
      run: request => next.scenario === 'readback_unavailable' && next.task.verifications.length === 0 ? null : connector.read(request) }
  ]);
  const agent = createLocalTaskAgent({ getTask: () => next.task, checkpoint: task => { next.task = task; },
    planner: { proposePlan: () => ({ items: itemsFor(kind) }) }, gateway,
    writeCapabilityId: 'supplement.write', readCapabilityId: 'supplement.read' });
  if (operation === 'preview') {
    if (next.task.status === 'NOT_CHECKED') agent.check(true);
    agent.propose({ input: {}, planId: `${next.task.id}:${randomUUID()}` });
  } else if (operation === 'confirm') agent.approve({ planId, confirmed });
  else if (operation === 'execute') {
    require(scenarios.includes(scenario));
    next.scenario = scenario;
    agent.execute({ runId: randomUUID(), uncertain: scenario === 'response_lost' });
    next.submissionCount = 1;
  } else {
    require(['SUBMITTED', 'UNKNOWN'].includes(next.task.status));
    agent.verify();
    next.review = reviewFor(next.task);
  }
  next.values = connector.snapshot();
  validateSupplemental(next, sessionId, kind);
  return next;
}
