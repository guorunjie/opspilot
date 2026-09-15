// test/connectorRegistrySafety.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorRegistry } from '../src/connector/connectorRegistry.js';

const NOW = '2026-09-16T00:00:00.000Z';
const MAX_AGE_MS = 60000;
const KEYS = ['demo.location'];

const MANIFEST = {
  schemaVersion: 1,
  id: 'demo.connector',
  label: 'Demo',
  version: '1.0.0',
  platformIds: ['demo'],
  capabilities: [
    { id: 'demo.read', label: 'Read', operation: 'read', execution: 'local', simulated: true },
  ],
  requiredConfigKeys: ['demo.location'],
};

const options = () => ({ configuredKeys: [...KEYS], now: NOW, maxAgeMs: MAX_AGE_MS });

function makeHook(result = { status: 'available', checkedAt: NOW }) {
  const hook = async () => result;
  hook.calls = [];
  const wrapped = (...args) => {
    hook.calls.push(args);
    return hook(...args);
  };
  wrapped.calls = hook.calls;
  return wrapped;
}

function ready() {
  const registry = createConnectorRegistry();
  return registry;
}

test('(1) invalid now/maxAge reject before hook, then valid call succeeds with no stuck fence', async () => {
  const registry = ready();
  const hook = makeHook();
  registry.register(MANIFEST, { probe: hook });

  await assert.rejects(() => registry.probe('demo.connector', { ...options(), now: 'not-a-date' }), TypeError);
  await assert.rejects(() => registry.probe('demo.connector', { ...options(), maxAgeMs: -1 }), TypeError);
  assert.equal(hook.calls.length, 0, 'hook must not run for invalid options');

  const result = await registry.probe('demo.connector', options());
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.missingKeys, []);
  assert.deepEqual(hook.calls[0], [], 'hook called with zero arguments');

  const inspected = await registry.inspect('demo.connector', options());
  assert.notEqual(inspected.status, 'UNKNOWN', 'no stuck inFlight after rejected calls');
});

test('(2) configuredKeys array getter is rejected without invoking the getter', async () => {
  const registry = ready();
  const hook = makeHook();
  registry.register(MANIFEST, { probe: hook });

  let invoked = false;
  const hostile = { now: NOW, maxAgeMs: MAX_AGE_MS };
  Object.defineProperty(hostile, 'configuredKeys', {
    enumerable: true,
    get() { invoked = true; return [...KEYS]; },
  });

  await assert.rejects(() => registry.probe('demo.connector', hostile), TypeError);
  assert.equal(invoked, false);
  assert.equal(hook.calls.length, 0);
});

test('(3) register options getter and symbol keys reject without invoking the getter', () => {
  const registry = ready();
  let invoked = false;
  const hostile = { get probe() { invoked = true; return async () => ({ status: 'available', checkedAt: NOW }); } };

  assert.throws(() => registry.register(MANIFEST, hostile), TypeError);
  assert.equal(invoked, false);

  const symbolOptions = { [Symbol('probe')]: async () => ({ status: 'available', checkedAt: NOW }) };
  assert.throws(() => registry.register({ ...MANIFEST, id: 'demo.symbol' }, symbolOptions), TypeError);
  assert.equal(invoked, false);
});

test('(4) unknown probe option cannot inject a renderer-provided result', async () => {
  const registry = ready();
  const hook = makeHook();
  registry.register(MANIFEST, { probe: hook });

  await assert.rejects(() => registry.probe('demo.connector', {
    ...options(), probe: {status:'available', checkedAt:NOW}
  }), TypeError);
  assert.equal(hook.calls.length, 0);
});

test('invalid hook results clear previous READY without reading accessors', async () => {
  const registry = ready();
  let raw = {status:'available', checkedAt:NOW};
  registry.register(MANIFEST, {probe:()=>raw});
  assert.equal((await registry.probe(MANIFEST.id, options())).status, 'READY');
  let hits = 0;
  raw = {get status(){hits++; return 'available';}, checkedAt:NOW};
  assert.equal((await registry.probe(MANIFEST.id, options())).status, 'UNKNOWN');
  assert.equal(hits, 0);
  assert.equal(registry.inspect(MANIFEST.id, options()).status, 'UNKNOWN');
  raw = {status:'available', checkedAt:NOW};
  await registry.probe(MANIFEST.id, options());
  raw = {status:'available', checkedAt:NOW, extra:'not allowed'};
  assert.equal((await registry.probe(MANIFEST.id, options())).status, 'UNKNOWN');
  assert.equal(registry.inspect(MANIFEST.id, options()).status, 'UNKNOWN');
});
test('array element getter is rejected without invocation', async () => {
  const registry = ready(); registry.register(MANIFEST);
  let hits = 0; const keys = [];
  Object.defineProperty(keys, '0', {get(){hits++; return 'demo.location';}});
  await assert.rejects(()=>registry.probe(MANIFEST.id, {...options(),configuredKeys:keys}), TypeError);
  assert.equal(hits,0);
});

test('(7) synchronous hook re-enters probe for the same id: outer succeeds, nested rejects in flight', async () => {
  const registry = ready();
  let nestedAssertion = null;

  registry.register(MANIFEST, {
    probe: () => {
      const nested = registry.probe('demo.connector', options());
      // attach a handler immediately so the rejection is never unhandled
      nestedAssertion = assert.rejects(() => nested, / in flight/);
      nestedAssertion.catch(() => {});
      return { status: 'available', checkedAt: NOW };
    },
  });

  const result = await registry.probe('demo.connector', options());
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.missingKeys, []);
  await nestedAssertion;
});

test('(8) mutating caller config array/time while a deferred hook runs keeps original validated input', async () => {
  const registry = ready();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  registry.register(MANIFEST, {
    probe: async () => {
      await gate;
      return { status: 'available', checkedAt: NOW };
    },
  });

  const callerOptions = options();
  const pending = registry.probe('demo.connector', callerOptions);

  callerOptions.configuredKeys.length = 0;
  callerOptions.now = '2030-01-01T00:00:00.000Z';
  callerOptions.maxAgeMs = 1;

  release();
  const result = await pending;
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.missingKeys, []);
  assert.notEqual(result.checkedAt, callerOptions.now);
});

test('(9) missing or throwing hook returns frozen UNKNOWN with frozen empty missingKeys', async () => {
  const registry = ready();
  registry.register(MANIFEST, {});
  registry.register({ ...MANIFEST, id: 'demo.throwing' }, {
    probe: () => { throw new Error('raw secret 0xdeadbeef'); },
  });

  const noHook = await registry.probe('demo.connector', options());
  assert.equal(noHook.status, 'UNKNOWN');
  assert.ok(Array.isArray(noHook.missingKeys));
  assert.equal(noHook.missingKeys.length, 0);
  assert.ok(Object.isFrozen(noHook));
  assert.ok(Object.isFrozen(noHook.missingKeys));

  let thrown;
  try {
    thrown = await registry.probe('demo.throwing', options());
  } catch (error) {
    assert.fail(`hook error must not leak raw: ${error && error.message}`);
  }
  assert.equal(thrown.status, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(thrown), /0xdeadbeef/);
});
