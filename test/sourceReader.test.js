import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceReader } from '../src/connector/sourceReader.js';

const clock = () => '2026-09-16T00:00:01.000Z';
const capability = {
  id: 'products', label: 'Products', operation: 'read',
  execution: 'host', simulated: false,
};
const manifest = (over = {}) => ({
  schemaVersion: 1, id: 'example', label: 'Example', version: '0.1.0',
  platformIds: ['p'], requiredConfigKeys: [],
  capabilities: [capability], ...over,
});
const RAW = {
  observationId: 'o', sourceId: 'example', mode: 'host', platformId: 'p',
  storeId: 's', observedAt: '2026-09-16T00:00:00.000Z',
  products: [{ id: 'x', cost: 0, stock: null }],
};
const scope = () => ({ platformId: 'p', storeId: 's' });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const make = (over = {}) => createSourceReader({
  manifest: manifest(),
  capabilityId: 'products',
  read: async () => RAW,
  authorizeRead: async () => true,
  validateCurrent: () => true,
  clock,
  ...over,
});
const collect = (reader, args = {}) =>
  reader.collect({ scope: scope(), maxAgeMs: 60000, ...args });

test('normalized result is flat, frozen, clocked after read', async () => {
  const order = [];
  const reader = make({
    read: async (a) => { order.push('read'); assert.ok(Object.isFrozen(a.scope)); return RAW; },
    clock: () => { order.push('clock'); return clock(); },
  });
  const r = await collect(reader);
  assert.deepEqual(order, ['read', 'clock']);
  assert.equal(r.status, 'READY');
  assert.equal(r.sourceId, 'example');
  assert.equal(r.mode, 'host');
  assert.ok(Array.isArray(r.products));
  assert.equal(r.products[0].cost, 0);
  assert.equal(r.products[0].stock, null);
  assert.equal(r.platformId, 'p');
  assert.equal(r.storeId, 's');
  assert.equal('observation' in r, false);
  assert.equal('metadata' in r, false);
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.products));
});

test('missing numeric fields normalize to null', async () => {
  const reader = make({
    read: async () => ({ ...RAW, products: [{ id: 'x' }, { id: 'y', cost: 2 }] }),
  });
  const r = await collect(reader);
  assert.equal(r.products[0].price, null);
  assert.equal(r.products[0].cost, null);
  assert.equal(r.products[0].stock, null);
  assert.equal(r.products[1].cost, 2);
});

test('hooks receive fresh argument objects and immutable scope', async () => {
  const seen = [];
  const cap = (name) => async (a) => {
    seen.push([name, a]);
    assert.ok(Object.isFrozen(a.scope));
    assert.ok(Object.isFrozen(a.scope));
    assert.deepEqual(a.scope, { platformId: 'p', storeId: 's' });
    assert.equal(a.capabilityId, 'products');
    assert.equal(a.connectorId, 'example');
    assert.ok(a.signal === undefined || a.signal instanceof AbortSignal);
    return name === 'read' ? RAW : true;
  };
  const reader = make({
    authorizeRead: cap('authorizeRead'),
    validateCurrent: (a) => { seen.push(['validateCurrent', a]); return true; },
    read: cap('read'),
  });
  await collect(reader);
  assert.deepEqual(seen.map(([n]) => n), ['authorizeRead', 'validateCurrent', 'read']);
  assert.notEqual(seen[0][1], seen[2][1]);
  assert.deepEqual(seen[0][1].scope, seen[2][1].scope);
});

for (const value of [false, 'true', 1]) {
  test(`authorizeRead ${JSON.stringify(value)} rejects before read`, async () => {
    let reads = 0;
    const reader = make({
      authorizeRead: async () => value,
      read: async () => { reads += 1; return RAW; },
    });
    await assert.rejects(collect(reader));
    assert.equal(reads, 0);
  });
}

for (const [name, fn] of [
  ['false', () => false],
  ['async true', async () => true],
  ['rejected', () => Promise.reject(new Error('nope'))],
]) {
  test(`validateCurrent ${name} rejects before read`, async () => {
    let reads = 0;
    const reader = make({
      validateCurrent: fn,
      read: async () => { reads += 1; return RAW; },
    });
    await assert.rejects(collect(reader));
    assert.equal(reads, 0);
  });
}

test('write capability rejects at construction', () => {
  assert.throws(() => createSourceReader({
    manifest: manifest({
      capabilities: [{ ...capability, operation: 'write' }],
    }),
    capabilityId: 'products',
    read: async () => RAW,
    authorizeRead: async () => true,
    validateCurrent: () => true,
    clock,
  }));
});

test('unknown capabilityId rejects at construction', () => {
  assert.throws(() => make({ capabilityId: 'missing' }));
});

for (const [label, raw] of [
  ['sourceId', { ...RAW, sourceId: 'other' }],
  ['mode', { ...RAW, mode: 'synthetic' }],
]) {
  test(`raw ${label} mismatch rejects`, async () => {
    await assert.rejects(collect(make({ read: async () => raw })));
  });
}

test('raw store mismatch yields UNKNOWN with empty products', async () => {
  const r = await collect(make({
    read: async () => ({ ...RAW, storeId: 'other' }),
  }));
  assert.equal(r.status, 'UNKNOWN');
  assert.deepEqual(r.products, []);
  assert.equal(r.sourceId, 'example');
  assert.ok(Object.isFrozen(r));
});

test('fresh clock after slow read marks stale UNKNOWN', async () => {
  const slow = deferred();
  const reader = make({
    read: () => slow.promise,
    clock: () => '2026-09-16T00:10:00.000Z',
  });
  const pending = collect(reader);
  slow.resolve(RAW);
  const r = await pending;
  assert.equal(r.status, 'UNKNOWN');
  assert.deepEqual(r.products, []);
});

test('abort before auth prevents read', async () => {
  const c = new AbortController();
  c.abort();
  let reads = 0, auths = 0;
  const reader = make({
    authorizeRead: async () => { auths += 1; return true; },
    read: async () => { reads += 1; return RAW; },
  });
  await assert.rejects(collect(reader, { signal: c.signal }), (e) => e.name === 'AbortError');
  assert.equal(auths, 0);
  assert.equal(reads, 0);
});

test('abort mid-read retains inFlight until original settles', async () => {
  const entered = deferred();
  const slow = deferred();
  const c = new AbortController();
  let reads = 0;
  const reader = make({
    read: async () => {
      reads += 1;
      if (reads === 1) { entered.resolve(); return slow.promise; }
      return RAW;
    },
  });
  const first = collect(reader, { signal: c.signal });
  const firstOutcome = first.then(() => 'ok', (e) => e);
  await entered.promise;
  c.abort();
  await assert.rejects(collect(reader), /already in flight/);
  assert.equal(reads, 1);
  slow.resolve(RAW);
  const err = await firstOutcome;
  assert.equal(err.name, 'AbortError');
  const r = await collect(reader);
  assert.equal(r.status, 'READY');
  assert.equal(reads, 2);
});

test('read error identity preserved with no retry', async () => {
  const boom = new Error('boom');
  let reads = 0;
  const reader = make({
    read: async () => { reads += 1; throw boom; },
  });
  const seen = await collect(reader).then(() => null, (e) => e);
  assert.equal(seen, boom);
  assert.equal(reads, 1);
});

test('caller mutation of scope during auth cannot change capture', async () => {
  const gate = deferred();
  const input = scope();
  let captured;
  const reader = make({
    authorizeRead: async () => { await gate.promise; return true; },
    read: async (a) => { captured = a.scope; return RAW; },
  });
  const pending = reader.collect({ scope: input, maxAgeMs: 60000 });
  input.storeId = 'hacked';
  input.platformId = 'other';
  gate.resolve();
  const r = await pending;
  assert.deepEqual(captured, { platformId: 'p', storeId: 's' });
  assert.equal(r.platformId, 'p');
  assert.equal(r.storeId, 's');
});

for (const [label, bad] of [
  ['missing key', { platformId: 'p' }],
  ['whitespace', { platformId: '  ', storeId: 's' }],
  ['non-string', { platformId: 1, storeId: 's' }],
  ['accessor', Object.defineProperty({ storeId: 's' }, 'platformId', { get: () => 'p', enumerable: true })],
  ['unknown key', { platformId: 'p', storeId: 's', extra: 1 }],
]) {
  test(`invalid scope (${label}) rejects before hooks`, async () => {
    let calls = 0;
    const reader = make({
      authorizeRead: async () => { calls += 1; return true; },
      validateCurrent: () => { calls += 1; return true; },
      read: async () => { calls += 1; return RAW; },
    });
    await assert.rejects(reader.collect({ scope: bad, maxAgeMs: 60000 }));
    assert.equal(calls, 0);
  });
}
