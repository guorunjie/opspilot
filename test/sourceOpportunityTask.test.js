// DS058 draft corrected by GPT against actual Task/storage contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareSourceOpportunityTask } from '../src/task/sourceOpportunityTask.js';
import { buildSourceOpportunities } from '../src/domain/model/sourceOpportunities.js';
import { advanceTask } from '../src/task/taskState.js';
import { openPersistentTask } from '../src/storage/persistentTask.js';
import { openStateStore } from '../src/storage/sqliteStateStore.js';

const rawFixture = () => ({
  observationId: 'o',
  sourceId: 'example',
  mode: 'synthetic',
  platformId: 'p',
  storeId: 's',
  observedAt: '2026-09-16T00:00:00.000Z',
  products: [
    {
      id: 'x',
      price: 200,
      cost: 100,
      referencePrice: 180,
      stock: 0,
      warehouseAvailable: 5,
      campaignId: 'c1',
      campaignPrice: 180,
      campaignEligible: true,
      campaignEnrolled: false,
    },
  ],
});

const optionsFixture = () => ({
  expectedScope: { platformId: 'p', storeId: 's' },
  now: '2026-09-16T00:00:01.000Z',
  maxAgeMs: 60000,
});

const buildPreview = (raw = rawFixture(), options = optionsFixture()) => {
  const built = buildSourceOpportunities(raw, options);
  assert.ok(Array.isArray(built.opportunities));
  assert.ok(built.opportunities.length > 0);
  for (const opportunity of built.opportunities) {
    assert.equal(typeof opportunity.id, 'string');
    assert.ok(opportunity.id.length > 0);
    assert.ok(['pricing', 'inventory', 'campaign', 'data_quality'].includes(opportunity.kind));
    assert.equal(opportunity.productId, 'x');
    assert.ok(opportunity.proposal !== undefined);
    assert.ok(opportunity.source !== undefined);
  }
  return built;
};

const selectKinds = (built) => ({
  pricing: built.opportunities.find((o) => o.kind === 'pricing'),
  inventory: built.opportunities.find((o) => o.kind === 'inventory'),
  campaign: built.opportunities.find((o) => o.kind === 'campaign'),
});

const prepare = ({ raw = rawFixture(), options = optionsFixture(), opportunityId, taskId = 't' } = {}) =>
  prepareSourceOpportunityTask({
    input: raw,
    options,
    opportunityId,
    taskId,
    planId: 'plan',
    namespace: 'test',
  });

const expectItem = (task, kind, targetId, before, value) => {
  const item = task.plan.items.find((i) => i.targetId === targetId);
  assert.ok(item, `missing plan item ${targetId} for ${kind}`);
  assert.equal(item.before, before);
  assert.equal(item.value, value);
  return item;
};

test('pricing opportunity prepares AWAITING_APPROVAL task with preserved evidence and no approval/run', () => {
  const raw = rawFixture();
  const options = optionsFixture();
  const built = buildPreview(raw, options);
  const { pricing } = selectKinds(built);
  assert.ok(pricing, 'expected a pricing opportunity');

  const preview = prepare({ raw, options, opportunityId: pricing.id });

  assert.equal(preview.status, 'AWAITING_APPROVAL');
  assert.equal(preview.reason, 'separate_approval_required');
  assert.ok(preview.task);
  assert.equal(preview.task.approval, null);
  assert.equal(preview.task.run, null);

  assert.equal(preview.task.plan.items.length, 1);
  expectItem(preview.task, 'pricing', 'x', 200, 180);

  assert.deepEqual(preview.task.plan.sourceEvidence.observation, built.observation);
  assert.deepEqual(preview.task.plan.sourceEvidence.opportunity, pricing);
});

test('inventory opportunity prepares AWAITING_APPROVAL task with preserved evidence and no approval/run', () => {
  const raw = rawFixture();
  const options = optionsFixture();
  const built = buildPreview(raw, options);
  const { inventory } = selectKinds(built);
  assert.ok(inventory, 'expected an inventory opportunity');

  const preview = prepare({ raw, options, opportunityId: inventory.id });

  assert.equal(preview.status, 'AWAITING_APPROVAL');
  assert.equal(preview.reason, 'separate_approval_required');
  assert.equal(preview.task.approval, null);
  assert.equal(preview.task.run, null);

  expectItem(preview.task, 'inventory', 'inventory:x', 0, 5);
  assert.deepEqual(preview.task.plan.sourceEvidence.observation, built.observation);
  assert.deepEqual(preview.task.plan.sourceEvidence.opportunity, inventory);
});

test('campaign opportunity prepares AWAITING_APPROVAL task with preserved evidence and no approval/run', () => {
  const raw = rawFixture();
  const options = optionsFixture();
  const built = buildPreview(raw, options);
  const { campaign } = selectKinds(built);
  assert.ok(campaign, 'expected a campaign opportunity');

  const preview = prepare({ raw, options, opportunityId: campaign.id });

  assert.equal(preview.status, 'AWAITING_APPROVAL');
  assert.equal(preview.reason, 'separate_approval_required');
  assert.equal(preview.task.approval, null);
  assert.equal(preview.task.run, null);

  const item = preview.task.plan.items[0];
  assert.equal(item.before, 0);
  assert.equal(item.value, 1);
  assert.match(item.targetId, /^campaign:[0-9a-f]{64}$/);
  assert.deepEqual(preview.task.plan.sourceEvidence.observation, built.observation);
  assert.deepEqual(preview.task.plan.sourceEvidence.opportunity, campaign);
});

test('START transition on an unapproved prepared task throws', () => {
  const raw = rawFixture();
  const options = optionsFixture();
  const built = buildPreview(raw, options);
  const { pricing } = selectKinds(built);
  const preview = prepare({ raw, options, opportunityId: pricing.id });

  assert.equal(preview.status, 'AWAITING_APPROVAL');
  assert.equal(preview.task.approval, null);
  assert.equal(preview.task.run, null);
  assert.throws(() => advanceTask(preview.task, { type: 'START', at: options.now, runId: 'run' }));
});

test('stale observation, cross-store scope and wrong selection return task null', () => {
  const built = buildPreview();
  const { pricing } = selectKinds(built);
  assert.ok(pricing);

  const staleOptions = { ...optionsFixture(), now: '2026-09-16T00:10:00.000Z', maxAgeMs: 60000 };
  const stale = prepare({ options: staleOptions, opportunityId: pricing.id });
  assert.equal(stale.task, null);

  const crossStore = prepare({
    raw: { ...rawFixture(), storeId: 'other' },
    opportunityId: pricing.id,
  });
  assert.equal(crossStore.task, null);

  const wrongSelection = prepare({ opportunityId: 'unknown-opportunity-id' });
  assert.equal(wrongSelection.task, null);

  assert.throws(() => prepare({ opportunityId: undefined }));
});

test('missing cost yields UNSUPPORTED and null task', () => {
  const raw = rawFixture();
  raw.products[0].cost = null;
  const options = optionsFixture();
  const built = buildPreview(raw, options);
  const dataQuality = built.opportunities.find((o) => o.kind === 'data_quality');
  assert.ok(dataQuality, 'expected a data_quality opportunity');

  const preview = prepare({ raw, options, opportunityId: dataQuality.id });

  assert.equal(preview.status, 'UNSUPPORTED');
  assert.equal(preview.task, null);
});

test('whitespace-only taskId is rejected', () => {
  const built = buildPreview();
  const { pricing } = selectKinds(built);
  assert.ok(pricing);
  for (const taskId of ['   ', ' t ']) assert.throws(() => prepare({ opportunityId: pricing.id, taskId }));
});

test('distinct campaign ids produce distinct campaign target ids', () => {
  const options = optionsFixture();
  const rawC1 = rawFixture();
  const built1 = buildPreview(rawC1, options);
  const campaign1 = selectKinds(built1).campaign;
  assert.ok(campaign1);
  const preview1 = prepare({ raw: rawC1, options, opportunityId: campaign1.id });
  const id1 = preview1.task.plan.items[0].targetId;
  assert.match(id1, /^campaign:[0-9a-f]{64}$/);

  const rawC2 = rawFixture();
  rawC2.products[0].campaignId = 'c2';
  const built2 = buildPreview(rawC2, options);
  const campaign2 = selectKinds(built2).campaign;
  assert.ok(campaign2);
  const preview2 = prepare({ raw: rawC2, options, opportunityId: campaign2.id });
  const id2 = preview2.task.plan.items[0].targetId;
  assert.match(id2, /^campaign:[0-9a-f]{64}$/);

  assert.notEqual(id1, id2);
  assert.notEqual(campaign1.id, campaign2.id);
});

test('sqlite persistence retains full source evidence across close/reopen and detects tampering', () => {
  const raw = rawFixture();
  const options = optionsFixture();
  const built = buildPreview(raw, options);
  const { pricing } = selectKinds(built);
  assert.ok(pricing);
  const preview = prepare({ raw, options, opportunityId: pricing.id });

  const scope = {
    id: preview.task.id,
    namespace: preview.task.namespace,
    connectorId: preview.task.connectorId,
    storeId: preview.task.storeId,
  };

  const dir = mkdtempSync(path.join(os.tmpdir(), 'opspilot-source-task-'));
  const file = path.join(dir, 'state.sqlite');
  let store;
  try {
    store = openStateStore(file, 'tasks');
    let handle = openPersistentTask({ store, scope, create: true });

    for (const event of preview.task.history) {
      const previous = handle.getTask();
      const next = advanceTask(previous, event);
      handle.checkpoint(next, previous);
    }

    handle.getTask();
    store.close();
    store = openStateStore(file, 'tasks');

    handle = openPersistentTask({ store, scope });
    const reloaded = handle.getTask();

    assert.equal(reloaded.approval, null);
    assert.equal(reloaded.run, null);
    assert.deepEqual(reloaded.plan.sourceEvidence, preview.task.plan.sourceEvidence);
    assert.deepEqual(reloaded.plan.sourceEvidence.observation, built.observation);
    assert.deepEqual(reloaded.plan.sourceEvidence.opportunity, pricing);

    const record = store.read(`task:${preview.task.id}`);
    assert.ok(record);
    assert.equal(typeof record.revision, 'number');
    const value = structuredClone(record.value);
    value.task.plan.sourceEvidence.observation.storeId = 'tampered';
    store.save(`task:${preview.task.id}`, { ...record.value, task: value.task }, record.revision);
    assert.throws(() => handle.getTask(), /saved state differs from event history/);
  } finally {
    try {
      if (store) store.close();
    } catch {}
    const resolvedDir = path.resolve(dir);
    const parent = path.resolve(os.tmpdir());
    const base = path.basename(resolvedDir);
    if (path.dirname(resolvedDir) === parent && base.startsWith('opspilot-source-task-')) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
