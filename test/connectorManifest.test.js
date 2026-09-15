import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorManifest, assessConnectorReadiness } from '../src/connector/connectorManifest.js';

const NOW = '2025-01-01T00:00:00.000Z';
const base = (over = {}) => ({
  schemaVersion: 1,
  id: 'sample.connector',
  label: 'Sample Connector',
  version: '1.0.0',
  platformIds: ['sample.platform'],
  capabilities: [
    { id: 'sample.read', label: 'Read', operation: 'read', execution: 'local', simulated: false },
  ],
  requiredConfigKeys: ['sample.endpoint'],
  ...over,
});
const ready = (over = {}) => ({
  configuredKeys: ['sample.endpoint'],
  probe: { status: 'available', checkedAt: NOW },
  now: NOW,
  maxAgeMs: 60000,
  ...over,
});

test('valid manifest is deep-frozen and copies caller input', () => {
  const input = base();
  const m = createConnectorManifest(input);
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.platformIds) && Object.isFrozen(m.capabilities));
  assert.ok(Object.isFrozen(m.capabilities[0]) && Object.isFrozen(m.requiredConfigKeys));
  input.id = 'mutated';
  input.capabilities[0].id = 'mutated';
  assert.equal(m.id, 'sample.connector');
  assert.equal(m.capabilities[0].id, 'sample.read');
  assert.deepEqual(Object.keys(m), ['schemaVersion', 'id', 'label', 'version', 'platformIds', 'capabilities', 'requiredConfigKeys']);
});

test('local real write/compensate rejected; host declaration accepted but not authorization', () => {
  const write = { id: 'sample.write', label: 'W', operation: 'write', execution: 'local', simulated: false };
  assert.throws(() => createConnectorManifest(base({ capabilities: [write] })), /local write/);
  const comp = { id: 'sample.comp', label: 'C', operation: 'compensate', execution: 'local', simulated: false };
  assert.throws(() => createConnectorManifest(base({ capabilities: [comp] })), /local compensate/);
  const localSim = { ...write, simulated: true };
  assert.equal(createConnectorManifest(base({ capabilities: [localSim] })).capabilities[0].simulated, true);
  const host = { ...write, execution: 'host' };
  const m = createConnectorManifest(base({ capabilities: [host] }));
  assert.equal(m.capabilities[0].execution, 'host');
  assert.equal(Object.isFrozen(m.capabilities[0]), true);
  assert.ok(!JSON.stringify(m).includes('permission'));
});

test('unknown, secret, hook, URL and nested keys rejected', () => {
  assert.throws(() => createConnectorManifest(base({ url: 'https://x' })), /unknown key/);
  assert.throws(() => createConnectorManifest(base({ secret: 'x' })), /unknown key/);
  const cap = { id: 'a.b', label: 'A', operation: 'read', execution: 'local', simulated: false, selectors: [] };
  assert.throws(() => createConnectorManifest(base({ capabilities: [cap] })), /unknown key/);
});

test('duplicate ids, duplicate config keys, holes and limits rejected', () => {
  const dup = base({ platformIds: ['a.b', 'a.b'] });
  assert.throws(() => createConnectorManifest(dup), /duplicate/);
  const c1 = { id: 'x.y', label: 'X', operation: 'read', execution: 'local', simulated: false };
  assert.throws(() => createConnectorManifest(base({ capabilities: [c1, { ...c1 }] })), /duplicate/);
  assert.throws(() => createConnectorManifest(base({ requiredConfigKeys: ['a.b', 'a.b'] })), /duplicate/);
  const holed = ['a.b', 'c.d'];
  delete holed[0];
  assert.throws(() => createConnectorManifest(base({ platformIds: holed })), /sparse/);
  assert.throws(() => createConnectorManifest(base({ platformIds: [] })), /length/);
  assert.throws(() => createConnectorManifest(base({ capabilities: [] })), /length/);
});

test('bad version, label and accessor properties rejected without getter execution', () => {
  for (const version of ['1.0', '1.0.0.0', '01.0.0', '1.00.0', 'v1.0.0', '1.0.-1']) {
    assert.throws(() => createConnectorManifest(base({ version })), /version/);
  }
  for (const label of ['', '   ', 'x'.repeat(129), 'bad\u0007label']) {
    assert.throws(() => createConnectorManifest(base({ label })), /label/);
  }
  let ran = false;
  const trap = base();
  Object.defineProperty(trap, 'id', { get() { ran = true; return 'x'; }, enumerable: true });
  assert.throws(() => createConnectorManifest(trap), /accessor/);
  assert.equal(ran, false);
});

test('readiness: NOT_CONFIGURED reports missing keys without values', () => {
  const m = createConnectorManifest(base());
  const r = assessConnectorReadiness(m, ready({ configuredKeys: [] }));
  assert.deepEqual(r, { status: 'NOT_CONFIGURED', missingKeys: ['sample.endpoint'] });
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.missingKeys));
});

test('readiness: READY, UNAVAILABLE, UNKNOWN for missing or unknown probe', () => {
  const m = createConnectorManifest(base());
  assert.equal(assessConnectorReadiness(m, ready()).status, 'READY');
  assert.equal(assessConnectorReadiness(m, ready({ probe: { status: 'unavailable', checkedAt: NOW } })).status, 'UNAVAILABLE');
  assert.equal(assessConnectorReadiness(m, ready({ probe: { status: 'unknown', checkedAt: NOW } })).status, 'UNKNOWN');
  assert.equal(assessConnectorReadiness(m, ready({ probe: undefined })).status, 'UNKNOWN');
});

test('readiness: stale and future checkedAt yield UNKNOWN', () => {
  const m = createConnectorManifest(base());
  const stale = ready({ probe: { status: 'available', checkedAt: '2024-12-31T00:00:00.000Z' } });
  assert.equal(assessConnectorReadiness(m, stale).status, 'UNKNOWN');
  const future = ready({ probe: { status: 'available', checkedAt: '2025-01-02T00:00:00.000Z' } });
  assert.equal(assessConnectorReadiness(m, future).status, 'UNKNOWN');
});

test('readiness: malformed time, bad maxAge, unknown fields and bad keys rejected', () => {
  const m = createConnectorManifest(base());
  for (const now of ['2025-01-01T00:00:00Z', 'not-a-time', '2025-01-01']) {
    assert.throws(() => assessConnectorReadiness(m, ready({ now })), /ISO/);
  }
  for (const maxAgeMs of [0, -1, 86400001, 1.5, '1000']) {
    assert.throws(() => assessConnectorReadiness(m, ready({ maxAgeMs })), /maxAgeMs/);
  }
  assert.throws(() => assessConnectorReadiness(m, ready({ extra: true })), /unknown key/);
  assert.throws(() => assessConnectorReadiness(m, ready({ configuredKeys: ['BAD'] })), /identifier/);
  assert.equal(assessConnectorReadiness(m, ready({ probe: { status: 'available' } })).status, 'UNKNOWN');
  assert.throws(() => assessConnectorReadiness(m, ready({ probe: { status: 'ok', checkedAt: NOW } })), /status/);
});

test('readiness re-validates a frozen manifest through the canonical constructor', () => {
  const m = createConnectorManifest(base());
  const tampered = Object.freeze({ ...m, capabilities: Object.freeze([{ id: 'x', label: 'X', operation: 'write', execution: 'local', simulated: false }]) });
  assert.throws(() => assessConnectorReadiness(tampered, ready()), /local write/);
  assert.throws(() => assessConnectorReadiness(base({ id: 'BAD' }), ready()), /identifier/);
});

const checked = (over) => assessConnectorReadiness(base(), ready(over));
const unchecked = (over) => checked({ probe: undefined, ...over });
test('denseArray rejects accessor indices and never runs index getters', () => {
  const seen = [];
  const arr = ['a', 'b'];
  Object.defineProperty(arr, '1', {
    get() { seen.push('index'); return 'b'; },
    enumerable: true, configurable: true,
  });
  assert.throws(() => createConnectorManifest({
    schemaVersion: 1, id: 'conn.x', label: 'X', version: '1.0.0',
    platformIds: arr, capabilities: [{ id: 'c', label: 'C', operation: 'read', execution: 'local', simulated: false }],
    requiredConfigKeys: [],
  }), /accessor property/);
  assert.deepStrictEqual(seen, []);
});

test('platformIds/capabilities/configuredKeys index getters are never executed', () => {
  const hits = [];
  const mk = (name, extra) => {
    const arr = ['x'];
    Object.defineProperty(arr, '0', { get() { hits.push(name); return 'x'; }, configurable: true });
    Object.defineProperty(arr, 'extra', { value: 1, enumerable: true, configurable: true });
    return { arr, extra };
  };
  const p = mk('platformIds');
  assert.throws(() => createConnectorManifest({
    schemaVersion: 1, id: 'conn.x', label: 'X', version: '1.0.0',
    platformIds: p.arr, capabilities: [{ id: 'c', label: 'C', operation: 'read', execution: 'local', simulated: false }],
    requiredConfigKeys: [],
  }), /unexpected property|accessor property/);
  assert.deepStrictEqual(hits, []);

  const c = mk('capabilities');
  assert.throws(() => createConnectorManifest({
    schemaVersion: 1, id: 'conn.x', label: 'X', version: '1.0.0',
    platformIds: ['p'], capabilities: c.arr, requiredConfigKeys: [],
  }), /unexpected property|accessor property/);
  assert.deepStrictEqual(hits, []);
});

test('overridden map and Symbol.iterator are not called by denseArray', () => {
  let calls = 0;
  const arr = ['a'];
  arr.map = () => { calls += 1; return ['evil']; };
  arr[Symbol.iterator] = () => { calls += 1; return ['evil'][Symbol.iterator](); };
  assert.throws(() => createConnectorManifest({
    schemaVersion: 1, id: 'conn.x', label: 'X', version: '1.0.0',
    platformIds: arr, capabilities: [{ id: 'c', label: 'C', operation: 'read', execution: 'local', simulated: false }],
    requiredConfigKeys: [],
  }), /unexpected property/);
  assert.strictEqual(calls, 0);
});

test('denseArray rejects symbols, holes, nonstandard prototypes and length overflow', () => {
  const withSymbol = ['a'];
  withSymbol[Symbol('s')] = 1;
  assert.throws(() => createConnectorManifest({
    schemaVersion: 1, id: 'conn.x', label: 'X', version: '1.0.0',
    platformIds: withSymbol, capabilities: [{ id: 'c', label: 'C', operation: 'read', execution: 'local', simulated: false }],
    requiredConfigKeys: [],
  }), /symbol keys are not allowed/);

  const nonstandard = ['a'];
  Object.setPrototypeOf(nonstandard, null);
  assert.throws(() => createConnectorManifest({
    schemaVersion: 1, id: 'conn.x', label: 'X', version: '1.0.0',
    platformIds: nonstandard, capabilities: [{ id: 'c', label: 'C', operation: 'read', execution: 'local', simulated: false }],
    requiredConfigKeys: [],
  }), /only Array.prototype/);
});

test('valid platformIds/capabilities are copied into new plain arrays', () => {
  const src = ['p1', 'p2'];
  const manifest = createConnectorManifest({
    schemaVersion: 1, id: 'conn.x', label: 'X', version: '1.0.0',
    platformIds: src, capabilities: [{ id: 'c', label: 'C', operation: 'read', execution: 'local', simulated: false }],
    requiredConfigKeys: ['k'],
  });
  assert.notStrictEqual(manifest.platformIds, src);
  src.push('p3');
  assert.deepStrictEqual(manifest.platformIds.slice(), ['p1', 'p2']);
  assert.ok(Object.isFrozen(manifest.platformIds));
});

test('invalid probe throws even when config is missing (NOT_CONFIGURED path)', () => {
  assert.throws(() => checked({
    configuredKeys: [],
    probe: { status: 'nope', checkedAt: NOW },
  }), /probe.status/);
  assert.throws(() => checked({
    configuredKeys: [],
    probe: { status: 'available', checkedAt: NOW, extra: 1 },
  }), /unknown key/);
});

test('probe accessor getters are never executed before the missing-config return', () => {
  const hits = [];
  const probe = {};
  Object.defineProperty(probe, 'status', {
    get() { hits.push('status'); return 'available'; },
    enumerable: true, configurable: true,
  });
  Object.defineProperty(probe, 'checkedAt', { value: NOW, enumerable: true, configurable: true });
  assert.throws(() => checked({ configuredKeys: [], probe }), /accessor property/);
  assert.deepStrictEqual(hits, []);
});

test('missing probe or missing checkedAt yields UNKNOWN once config is complete', () => {
  assert.deepStrictEqual(unchecked({}).status, 'UNKNOWN');
  assert.deepStrictEqual(unchecked({ probe: { status: 'available' } }).status, 'UNKNOWN');
  assert.deepStrictEqual(checked({ probe: undefined }).status, 'UNKNOWN');
});

test('probe is READY only when checkedAt is exactly within maxAge and not future', () => {
  const now = Date.parse(NOW);
  const at = (offset) => new Date(now + offset).toISOString();
  assert.strictEqual(checked({ configuredKeys: ['sample.endpoint'], probe: { status: 'available', checkedAt: at(0) } }).status, 'READY');
  assert.strictEqual(checked({ configuredKeys: ['sample.endpoint'], maxAgeMs: 1000, probe: { status: 'available', checkedAt: at(-1000) } }).status, 'READY');
  assert.strictEqual(checked({ configuredKeys: ['sample.endpoint'], maxAgeMs: 1000, probe: { status: 'available', checkedAt: at(-1001) } }).status, 'UNKNOWN');
  assert.strictEqual(checked({ configuredKeys: ['sample.endpoint'], probe: { status: 'available', checkedAt: at(1) } }).status, 'UNKNOWN');
});

test('NOT_CONFIGURED still wins after a fully valid probe', () => {
  const out = checked({ configuredKeys: [], probe: { status: 'available', checkedAt: NOW } });
  assert.strictEqual(out.status, 'NOT_CONFIGURED');
  assert.ok(Object.isFrozen(out));
  assert.ok(Object.isFrozen(out.missingKeys));
});
