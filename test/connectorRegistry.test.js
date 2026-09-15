// test/connectorRegistry.test.js
// Node 24 ESM tests using node:test and node:assert/strict. No real network,
// no real platform, no dependencies.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorRegistry } from '../src/connector/connectorRegistry.js';

function baseManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'demo.connector',
    label: 'Demo Connector',
    version: '1.0.0',
    platformIds: ['synthetic'],
    capabilities: [
      {
        id: 'demo.location.read',
        label: 'Read location',
        operation: 'read',
        execution: 'local',
        simulated: true,
      },
    ],
    requiredConfigKeys: ['demo.location'],
    ...overrides,
  };
}

const CONFIGURED = ['demo.location'];
const NOW = '2024-01-02T03:04:05.678Z';
const FRESH = '2024-01-02T03:04:00.000Z'; // 5.678s before NOW
const STALE = '2024-01-02T02:00:00.000Z'; // far before NOW

test('empty registry has no default connectors', () => {
  const registry = createConnectorRegistry();
  const listed = registry.list();
  assert.equal(listed.length, 0);
  assert.ok(Object.isFrozen(listed));
});

test('duplicate id is rejected', () => {
  const registry = createConnectorRegistry();
  registry.register(baseManifest());
  assert.throws(() => registry.register(baseManifest()), /duplicate/i);
});

test('register copies the manifest and list returns frozen snapshots', () => {
  const registry = createConnectorRegistry();
  const input = baseManifest();
  registry.register(input);

  // Mutating the caller's object afterwards must not affect the registry.
  input.id = 'mutated.id';
  input.capabilities[0].simulated = false;
  input.requiredConfigKeys.push('demo.other');

  const listed = registry.list();
  assert.equal(listed.length, 1);
  const snapshot = listed[0];
  assert.equal(snapshot.id, 'demo.connector');
  assert.deepEqual(snapshot.requiredConfigKeys, ['demo.location']);
  assert.equal(snapshot.capabilities[0].simulated, true);

  assert.ok(Object.isFrozen(listed));
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.capabilities));
  assert.ok(Object.isFrozen(snapshot.capabilities[0]));
  assert.ok(Object.isFrozen(snapshot.requiredConfigKeys));
  assert.equal(snapshot.lastProbe, null);
});

test('unknown id is rejected for inspect and probe', async () => {
  const registry = createConnectorRegistry();
  assert.throws(() => registry.inspect('nope.id', { configuredKeys: [] }), /unknown/i);
  await assert.rejects(() => registry.probe('nope.id', { configuredKeys: [] }), /unknown/i);
});

test('register rejects non-function probe and unexpected option keys', () => {
  const registry = createConnectorRegistry();
  assert.throws(
    () => registry.register(baseManifest(), { probe: 'not-a-function' }),
    TypeError,
  );
  assert.throws(
    () => registry.register(baseManifest(), { other: 1 }),
    /not allowed/i,
  );
});

test('inspect with missing config reports NOT_CONFIGURED and missing keys', () => {
  const registry = createConnectorRegistry();
  registry.register(baseManifest());
  const result = registry.inspect('demo.connector', { configuredKeys: [], maxAgeMs: 60_000, now: NOW });
  assert.equal(result.status, 'NOT_CONFIGURED');
  assert.deepEqual(result.missingKeys, ['demo.location']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.missingKeys));
});

test('missing config blocks the hook entirely (NOT_CONFIGURED, no call)', async () => {
  const registry = createConnectorRegistry();
  let calls = 0;
  registry.register(baseManifest(), {
    probe: () => {
      calls += 1;
      return { status: 'available', checkedAt: FRESH };
    },
  });

  const result = await registry.probe('demo.connector', { configuredKeys: [], maxAgeMs: 60_000, now: NOW });
  assert.equal(result.status, 'NOT_CONFIGURED');
  assert.deepEqual(result.missingKeys, ['demo.location']);
  assert.equal(calls, 0, 'hook must not run without configuration');
});

test('missing hook yields UNKNOWN', async () => {
  const registry = createConnectorRegistry();
  registry.register(baseManifest());
  const result = await registry.probe('demo.connector', {
    configuredKeys: CONFIGURED,
    maxAgeMs: 60_000, now: NOW,
  });
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(result.missingKeys, []);
  assert.equal(registry.inspect('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW }).status, 'UNKNOWN');
});

test('available probe becomes READY, then goes stale', async () => {
  const registry = createConnectorRegistry();
  registry.register(baseManifest(), {
    probe: () => ({ status: 'available', checkedAt: FRESH }),
  });

  const first = await registry.probe('demo.connector', {
    configuredKeys: CONFIGURED,
    maxAgeMs: 60_000, now: NOW,
  });
  assert.equal(first.status, 'READY');

  const fresh = registry.inspect('demo.connector', {
    configuredKeys: CONFIGURED,
    maxAgeMs: 60_000, now: NOW,
    maxAgeMs: 60_000,
  });
  assert.equal(fresh.status, 'READY');

  const stale = registry.inspect('demo.connector', {
    configuredKeys: CONFIGURED,
    now: '2024-01-02T04:00:00.000Z',
    maxAgeMs: 60_000,
  });
  assert.equal(stale.status, 'UNKNOWN');

  // list() also exposes the stored observation as an immutable snapshot.
  const snapshot = registry.list()[0];
  assert.deepEqual(snapshot.lastProbe, { status: 'available', checkedAt: FRESH });
  assert.ok(Object.isFrozen(snapshot.lastProbe));
});

test('unavailable probe is not READY and does not preserve READY', async () => {
  const registry = createConnectorRegistry();
  let mode = 'available';
  registry.register(baseManifest(), {
    probe: () => ({ status: mode, checkedAt: FRESH }),
  });

  assert.equal(
    (await registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW })).status,
    'READY',
  );

  mode = 'unavailable';
  const result = await registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW });
  assert.notEqual(result.status, 'READY');
  assert.notEqual(
    registry.inspect('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW }).status,
    'READY',
  );
});

test('malformed response after READY invalidates the stored success', async () => {
  const registry = createConnectorRegistry();
  let response = { status: 'available', checkedAt: FRESH };
  registry.register(baseManifest(), { probe: () => response });

  assert.equal(
    (await registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW })).status,
    'READY',
  );

  response = { status: 'definitely-not-a-status', checkedAt: FRESH };
  const result = await registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW });
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(result.missingKeys, []);
  assert.equal(
    registry.inspect('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW }).status,
    'UNKNOWN',
  );

  response = { status: 'available', checkedAt: FRESH };
  assert.equal(
    (await registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW })).status,
    'READY',
  );
});

test('thrown hook after READY invalidates and does not leak the exception', async () => {
  const registry = createConnectorRegistry();
  let shouldThrow = false;
  registry.register(baseManifest(), {
    probe: () => {
      if (shouldThrow) throw new Error('secret internal detail');
      return { status: 'available', checkedAt: FRESH };
    },
  });

  assert.equal(
    (await registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW })).status,
    'READY',
  );

  shouldThrow = true;
  const result = await registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW });
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(result.missingKeys, []);
  assert.ok(!JSON.stringify(result).includes('secret internal detail'));
  assert.equal(
    registry.inspect('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW }).status,
    'UNKNOWN',
  );
});

test('explicit missing timestamp yields UNKNOWN', async () => {
  const registry = createConnectorRegistry();
  registry.register(baseManifest(), {
    probe: () => ({ status: 'available' }),
  });

  const result = await registry.probe('demo.connector', {
    configuredKeys: CONFIGURED,
    maxAgeMs: 60_000, now: NOW,
  });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(registry.inspect('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW }).status, 'UNKNOWN');
});

test('malformed checkedAt yields UNKNOWN', async () => {
  const registry = createConnectorRegistry();
  registry.register(baseManifest(), {
    probe: () => ({ status: 'available', checkedAt: 'yesterday-ish' }),
  });

  const result = await registry.probe('demo.connector', {
    configuredKeys: CONFIGURED,
    maxAgeMs: 60_000, now: NOW,
  });
  assert.equal(result.status, 'UNKNOWN');
});

test('returned result has only status and missingKeys (no payload leak)', async () => {
  const registry = createConnectorRegistry();
  registry.register(baseManifest(), {
    probe: () => ({
      status: 'available',
      checkedAt: FRESH,
      secret: 'do-not-leak',
      extra: { nested: true },
    }),
  });

  const result = await registry.probe('demo.connector', {
    configuredKeys: CONFIGURED,
    maxAgeMs: 60_000, now: NOW,
  });
  assert.deepEqual(Object.keys(result).sort(), ['missingKeys', 'status']);
  assert.ok(!JSON.stringify(result).includes('do-not-leak'));
  assert.equal(registry.list()[0].lastProbe, null);
});

test('concurrent probe for the same id rejects; inspect/list stay usable', async () => {
  const registry = createConnectorRegistry();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  registry.register(baseManifest(), {
    probe: async () => {
      await gate;
      return { status: 'available', checkedAt: FRESH };
    },
  });

  const first = registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW });

  // While in flight, read paths remain fully usable.
  const duringInspect = registry.inspect('demo.connector', {
    configuredKeys: CONFIGURED,
    maxAgeMs: 60_000, now: NOW,
  });
  assert.equal(duringInspect.status, 'UNKNOWN');
  assert.equal(registry.list().length, 1);

  await assert.rejects(
    () => registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW }),
    /in flight/i,
  );

  release();
  const settled = await first;
  assert.equal(settled.status, 'READY');

  // Fence released after settlement: a later probe is allowed again.
  const third = await registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW });
  assert.equal(third.status, 'READY');
});

test('concurrent probes on different ids are independent', async () => {
  const registry = createConnectorRegistry();
  let releaseA;
  const gateA = new Promise((resolve) => {
    releaseA = resolve;
  });

  registry.register(baseManifest({ id: 'demo.alpha' }), {
    probe: async () => {
      await gateA;
      return { status: 'available', checkedAt: FRESH };
    },
  });
  registry.register(baseManifest({ id: 'demo.beta' }), {
    probe: () => ({ status: 'unavailable', checkedAt: FRESH }),
  });

  const pendingA = registry.probe('demo.alpha', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW });
  const resultB = await registry.probe('demo.beta', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW });
  assert.notEqual(resultB.status, 'READY');

  releaseA();
  const resultA = await pendingA;
  assert.equal(resultA.status, 'READY');
  assert.equal(
    registry.inspect('demo.beta', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW }).status,
    resultB.status,
  );
});

test('hook receives no arguments', async () => {
  const registry = createConnectorRegistry();
  let received = 'not-called';
  registry.register(baseManifest(), {
    probe: (...args) => {
      received = args;
      return { status: 'available', checkedAt: FRESH };
    },
  });

  await registry.probe('demo.connector', { configuredKeys: CONFIGURED, maxAgeMs: 60_000, now: NOW });
  assert.ok(Array.isArray(received));
  assert.equal(received.length, 0);
});

test('inspect never invokes the hook', () => {
  const registry = createConnectorRegistry();
  let calls = 0;
  registry.register(baseManifest(), {
    probe: () => {
      calls += 1;
      return { status: 'available', checkedAt: FRESH };
    },
  });

  registry.inspect('demo.connector', {
    configuredKeys: CONFIGURED,
    maxAgeMs: 60_000, now: NOW,
    maxAgeMs: 60_000,
  });
  assert.equal(calls, 0);
});
