// DS055 draft, corrected against actual opportunity schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceReader } from '../src/connector/sourceReader.js';

const manifest = { schemaVersion: 1, id: 'example', label: 'Example', version: '0.1.0',
  platformIds: ['p'], requiredConfigKeys: [], capabilities: [
    { id: 'products', label: 'Products', operation: 'read', execution: 'local', simulated: true }
  ] };
const raw = { observationId: 'o', sourceId: 'example', mode: 'synthetic', platformId: 'p',
  storeId: 's', observedAt: '2026-09-16T00:00:00.000Z',
  products: [{ id: 'x', price: 200, cost: 100, referencePrice: 180, stock: null }] };
const opts = { scope: { platformId: 'p', storeId: 's' }, maxAgeMs: 60000 };
function make(onRead = () => structuredClone(raw)) {
  let reads = 0, clocks = 0;
  const reader = createSourceReader({ manifest, capabilityId: 'products',
    read: async () => { reads++; return onRead(); }, authorizeRead: () => true, validateCurrent: () => true,
    clock: () => { clocks++; return '2026-09-16T00:00:01.000Z'; } });
  return { reader, get reads() { return reads; }, get clocks() { return clocks; } };
}

test('diagnosis derives immutable scoped proposals from exactly one read and clock', async () => {
  const f = make();
  const out = await f.reader.diagnose({ ...opts, minimumMargin: 0.2 });
  assert.equal(f.reads, 1); assert.equal(f.clocks, 1);
  assert.ok(Object.isFrozen(out));
  assert.equal(out.observation.observationId, 'o');
  assert.equal(out.observation.mode, 'synthetic');
  assert.equal(out.observation.products[0].stock, null);
  const proposed = out.opportunities.find(o => o.kind === 'pricing');
  assert.ok(proposed);
  assert.equal(proposed.proposal.before, 200); assert.equal(proposed.proposal.after, 180);
  assert.equal(proposed.requiresApproval, true); assert.equal(proposed.executable, false);
  assert.equal(proposed.source.observationId, 'o');
  assert.equal(proposed.source.storeId, 's'); assert.equal(proposed.source.platformId, 'p');
});

test('collect remains flat and separate from diagnosis', async () => {
  const f = make();
  const out = await f.reader.collect(opts);
  assert.equal(f.reads, 1); assert.equal(f.clocks, 1);
  assert.equal(out.observationId, 'o'); assert.equal(out.opportunities, undefined);
});

test('foreign and stale observations stay UNKNOWN with no products or opportunities', async () => {
  for (const foreign of [true, false]) {
    const f = make(() => ({ ...raw, storeId: foreign ? 'other' : 's' }));
    const out = await f.reader.diagnose({ ...opts, maxAgeMs: foreign ? 60000 : 1 });
    assert.equal(out.observation.status, 'UNKNOWN');
    assert.deepEqual(out.observation.products, []); assert.deepEqual(out.opportunities, []);
    assert.equal(out.observation.coverage, null);
  }
});

test('invalid margin causes no I/O and wrong connector is rejected before projection', async () => {
  const f = make();
  for (const minimumMargin of [2, -1, NaN, Infinity, '0.2', null])
    await assert.rejects(f.reader.diagnose({ ...opts, minimumMargin }));
  assert.equal(f.reads, 0); assert.equal(f.clocks, 0);
  const wrong = make(() => ({ ...raw, sourceId: 'other' }));
  await assert.rejects(wrong.reader.diagnose(opts), /sourceId/);
});

test('collect and diagnose share the pending-read lock, including cancellation', async () => {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const pendingRead = new Promise(resolve => { finish = resolve; });
  const f = make(() => { enter(); return pendingRead; });
  const controller = new AbortController();
  const pending = f.reader.diagnose({ ...opts, signal: controller.signal });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await entered; controller.abort(); await Promise.resolve();
  assert.equal(settled, false);
  await assert.rejects(f.reader.collect(opts), /in flight/);
  await assert.rejects(f.reader.diagnose(opts), /in flight/);
  assert.equal(f.reads, 1);
  finish(raw);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.clocks, 0);
});
