// src/connector/connectorRegistry.js
// Registry for connector manifests. Security posture:
// - Host callbacks (probe hooks) are trusted, readonly, never exposed to renderers.
// - All externally supplied option objects are validated structurally via
//   Reflect.ownKeys + property descriptors BEFORE any value is read, so a
//   getter/accessor or symbol key cannot execute or smuggle data.
// - Readiness is never decided here; the existing assessor is the only source
//   of READY/status. This module only normalizes what the assessor accepted.

import {
  createConnectorManifest,
  assessConnectorReadiness,
} from './connectorManifest.js';

const OPTION_KEYS = ['probe'];
const CALL_KEYS = ['configuredKeys', 'now', 'maxAgeMs'];

// Reject non-plain objects, symbols, unknown keys and accessors without reading
// any value. Returns a shallow copy of own data descriptors only.
function readStrictOptions(value, allowed, what) {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${what} must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${what} must be a plain own-data object`);
  }
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new TypeError(`${what} must not use symbol keys`);
    }
    if (!allowed.includes(key)) {
      throw new TypeError(`${what} field not allowed: ${key}`);
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc)) {
      throw new TypeError(`${what}.${key} must be a data property, not an accessor`);
    }
    copy[key] = desc.value; // copy, never spread unvalidated input
  }
  return copy;
}

function copyKeys(keys) {
  if (keys === undefined) return undefined;
  if (!Array.isArray(keys)) throw new TypeError('configuredKeys must be an array');
  return Object.freeze(Array.from(keys));
}

function freezeProbe(raw) {
  return Object.freeze({ status: raw.status, checkedAt: raw.checkedAt });
}

export function createConnectorRegistry() {
  const entries = new Map();

  function register(manifest, options = {}) {
    const opts = readStrictOptions(options, OPTION_KEYS, 'register options');
    let hook;
    if (opts.probe !== undefined) {
      if (typeof opts.probe !== 'function') {
        throw new TypeError('register options.probe must be a function');
      }
      hook = opts.probe; // trusted host callback; kept in closure, never exposed
    }

    // createConnectorManifest revalidates and deep-freezes a descriptor copy.
    const frozen = createConnectorManifest(manifest);
    const id = frozen.id;
    if (entries.has(id)) {
      throw new Error(`duplicate connector: ${id}`);
    }

    entries.set(id, {
      manifest: frozen,
      hook,
      inFlight: false,
      lastProbe: null,
    });

    return Object.freeze({ id });
  }

  function entryOf(id) {
    const entry = entries.get(id);
    if (!entry) throw new Error(`unknown connector: ${id}`);
    return entry;
  }

  function list() {
    const out = [];
    for (const entry of entries.values()) {
      const m = entry.manifest;
      out.push(Object.freeze({
        id: m.id,
        label: m.label,
        version: m.version,
        platformIds: m.platformIds, // already deep-frozen by constructor
        requiredConfigKeys: m.requiredConfigKeys,
        capabilities: m.capabilities,
        lastProbe: entry.lastProbe, // frozen copy or null
      }));
    }
    return Object.freeze(out);
  }

  function inspect(id, options = {}) {
    const entry = entryOf(id);
    const call = readStrictOptions(options, CALL_KEYS, 'inspect options');

    // Validate with the shipped assessor; no probe supplied here.
    assessConnectorReadiness(entry.manifest, {
      configuredKeys: call.configuredKeys,
      now: call.now,
      maxAgeMs: call.maxAgeMs,
    });
    // Capture an immutable snapshot BEFORE any await boundary.
    const configuredKeys = copyKeys(call.configuredKeys);
    const now = call.now;
    const maxAgeMs = call.maxAgeMs;

    return assessConnectorReadiness(entry.manifest, {
      configuredKeys,
      now,
      maxAgeMs,
      probe: entry.lastProbe ?? undefined,
    });
  }

  async function probe(id, options = {}) {
    const entry = entryOf(id);
    const call = readStrictOptions(options, CALL_KEYS, 'probe options');

    const pre = assessConnectorReadiness(entry.manifest, call);
    const base = Object.freeze({configuredKeys: copyKeys(call.configuredKeys), now: call.now, maxAgeMs: call.maxAgeMs});
    if (entry.inFlight) throw new Error('probe already in flight');
    if (pre.status === 'NOT_CONFIGURED' || typeof entry.hook !== 'function') {
      entry.lastProbe = null;
      return pre;
    }
    entry.inFlight = true;
    try {
      const hook = entry.hook;
      const raw = await hook(); // zero arguments and no internal entry as this
      // Same synchronous continuation: capture -> validate -> copy. The raw
      // value goes straight to the assessor so unknown fields/accessors are
      // rejected rather than silently stripped.
      const verdict = assessConnectorReadiness(entry.manifest, { ...base, probe: raw });
      if (raw === null || typeof raw !== 'object' || typeof raw.status !== 'string') {
        throw new TypeError('probe result must be an object with a string status');
      }
      const next = freezeProbe(
        typeof raw.checkedAt === 'string'
          ? { status: raw.status, checkedAt: raw.checkedAt }
          : { status: raw.status }
      );
      entry.lastProbe = next;
      return verdict;
    } catch {
      // Any real hook failure or result-validation failure clears prior state.
      entry.lastProbe = null;
      return Object.freeze({ status: 'UNKNOWN', missingKeys: Object.freeze([]) });
    } finally {
      entry.inFlight = false; // released only when the promise settles
    }
  }

  return Object.freeze({
    register,
    list,
    inspect,
    probe,
  });
}
