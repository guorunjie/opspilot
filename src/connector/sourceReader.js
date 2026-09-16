// src/connector/sourceReader.js
import { createConnectorManifest } from './connectorManifest.js';
import { normalizeSourceObservation } from '../domain/model/sourceObservation.js';
import { buildSourceOpportunities } from '../domain/model/sourceOpportunities.js';

const MAX_SCOPE_ID_LEN = 128;
const MAX_AGE_MS_LIMIT = 86400000;
// Reject C0/C1 control chars and DEL; trimmed, nonempty ids only.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function fail(message, ErrorType = TypeError) {
  throw new ErrorType(message);
}

function isFunction(value) {
  return typeof value === 'function';
}

function assertSafeIntMs(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_AGE_MS_LIMIT) {
    fail(`${label} must be a safe integer in 1..${MAX_AGE_MS_LIMIT}`);
  }
}

function readScopeId(raw, label) {
  if (typeof raw !== 'string') fail(`${label} must be a string`);
  if (raw !== raw.trim()) fail(`${label} must be trimmed`);
  const trimmed = raw;
  if (trimmed.length === 0) fail(`${label} must be nonempty`);
  if (trimmed.length > MAX_SCOPE_ID_LEN) fail(`${label} must be <= ${MAX_SCOPE_ID_LEN} chars`);
  if (CONTROL_CHARS.test(trimmed)) fail(`${label} must not contain control characters`);
  return trimmed;
}

// Validates the explicit scope, then freezes a detached clone of it.
function normalizeScope(rawScope, manifest) {
  if (rawScope === null || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
    fail('scope must be an object');
  }
  const proto = Object.getPrototypeOf(rawScope);
  if (proto !== Object.prototype && proto !== null) fail('scope must be plain data');
  for (const key of Reflect.ownKeys(rawScope)) {
    if (!['platformId', 'storeId'].includes(key) || !('value' in Object.getOwnPropertyDescriptor(rawScope, key))) fail('invalid scope property');
  }
  const platformId = readScopeId(rawScope.platformId, 'scope.platformId');
  const storeId = readScopeId(rawScope.storeId, 'scope.storeId');
  const platformIds = manifest.platformIds;
  if (!Array.isArray(platformIds) || !platformIds.includes(platformId)) {
    fail('scope.platformId is not declared by the manifest');
  }
  return Object.freeze({
    platformId,
    storeId,
  });
}

function assertSignal(signal) {
  if (signal === undefined) return;
  const looksLikeAbortSignal = typeof AbortSignal !== 'undefined' && signal instanceof AbortSignal;
  if (!looksLikeAbortSignal || !isFunction(signal.addEventListener)) {
    fail('signal must be an AbortSignal');
  }
}

function assertNotAborted(signal, phase) {
  if (signal !== undefined && signal.aborted === true) {
    const error = new Error(`read aborted (${phase})`);
    error.name = 'AbortError';
    throw error;
  }
}

function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && isFunction(value.then);
}

// Detached per-call hook argument; never carries config, secrets, or user data.
function buildHookArgs(scope, capabilityId, connectorId, signal) {
  return { scope, capabilityId, connectorId, signal };
}

function buildReadArgs(scope, capabilityId, connectorId, signal) {
  return { scope, capabilityId, connectorId, signal };
}

function callSynchronousGate(fn, args, label) {
  const result = fn(args);
  if (isThenable(result)) {
    // Swallow the rejected thenable so no unhandled rejection is produced,
    // then fail closed: the gate must be synchronous.
    Promise.resolve(result).then(undefined, () => {});
    fail(`${label} must be synchronous`);
  }
  if (result !== true) fail(`${label} must return literal true`);
}

function readStrictIsoNow(clock) {
  const now = clock();
  if (typeof now !== 'string') fail('clock() must return a string');
  const parsed = Date.parse(now);
  if (Number.isNaN(parsed)) fail('clock() must return a strict ISO timestamp');
  if (new Date(parsed).toISOString() !== now) fail('clock() must return a canonical ISO 8601 string');
  return now;
}

function normalizeIdentity(normalized, expected) {
  if (normalized === null || typeof normalized !== 'object') fail('normalized observation must be an object');
  if (normalized.sourceId !== expected.connectorId) {
    fail('normalized observation sourceId does not match connector');
  }
  if (normalized.mode !== expected.mode) {
    fail('normalized observation mode does not match capability execution');
  }
  return normalized;
}

export function createSourceReader({ manifest, capabilityId, read, authorizeRead, validateCurrent, clock }) {
  const validatedManifest = createConnectorManifest(manifest);

  if (typeof capabilityId !== 'string' || capabilityId.trim().length === 0) {
    fail('capabilityId must be a nonempty string');
  }
  const capabilities = validatedManifest.capabilities;
  const capability = Array.isArray(capabilities)
    ? capabilities.find((entry) => entry && entry.id === capabilityId)
    : undefined;
  if (capability === undefined) fail('capabilityId is not declared by the manifest');
  if (capability.operation !== 'read') fail('selected capability is not a read operation');

  if (!isFunction(read)) fail('read hook must be a function');
  if (!isFunction(authorizeRead)) fail('authorizeRead hook must be a function');
  if (!isFunction(validateCurrent)) fail('validateCurrent hook must be a function');
  if (!isFunction(clock)) fail('clock hook must be a function');

  const expectedMode = capability.simulated === true ? 'synthetic' : 'host';
  const connectorId = validatedManifest.id;
  const frozenManifest = validatedManifest;
  const hooks = { read, authorizeRead, validateCurrent, clock };

  let inFlight = false;

  async function collectInternal({ scope: rawScope, maxAgeMs, signal } = {}, minimumMargin, diagnosis = false) {
    // Concurrency guard: rejected/aborted calls must not clobber an active lock.
    if (inFlight) fail('a collect() call is already in flight on this reader');
    inFlight = true;

    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight = false;
      }
    };

    try {
      assertSignal(signal);
      assertNotAborted(signal, 'before hooks');
      assertSafeIntMs(maxAgeMs, 'maxAgeMs');
      const scope = normalizeScope(rawScope, frozenManifest);

      const authArgs = buildHookArgs(scope, capabilityId, connectorId, signal);
      const authResult = await hooks.authorizeRead(authArgs);
      // Authorization is answered only by the trusted host hook under current
      // host state; readiness/metadata booleans are never proof of authorization.
      if (authResult !== true) fail('authorizeRead did not authorize this read');
      assertNotAborted(signal, 'after authorizeRead');

      const validationArgs = buildHookArgs(scope, capabilityId, connectorId, signal);
      // validateCurrent() and read() are invoked with no await between them, so
      // the gate cannot go stale before dispatch.
      callSynchronousGate(hooks.validateCurrent, validationArgs, 'validateCurrent');
      assertNotAborted(signal, 'before read');

      const readArgs = buildReadArgs(scope, capabilityId, connectorId, signal);
      const rawPromise = hooks.read(readArgs);
      // Await the original promise: an abort signal is not proof of settlement.
      const raw = await rawPromise;
      assertNotAborted(signal, 'after read');

      // Clock is consulted only after the read has settled.
      const now = readStrictIsoNow(hooks.clock);
      const normalized = normalizeSourceObservation(raw, {
        expectedScope: scope,
        now,
        maxAgeMs,
      });
      const identity = normalizeIdentity(normalized, { connectorId, mode: expectedMode });
      if (!diagnosis) return identity;
      // Use the same authorized raw observation and completion time. The
      // normalized result contains status/coverage and is not raw input.
      return buildSourceOpportunities(raw, { expectedScope: scope, now, maxAgeMs, minimumMargin });
    } finally {
      // Released only after the original read promise has settled.
      release();
    }
  }

  async function collect(request = {}) {
    return collectInternal(request);
  }

  async function diagnose({ scope, maxAgeMs, signal, minimumMargin } = {}) {
    if (minimumMargin !== undefined && (typeof minimumMargin !== 'number'
      || !Number.isFinite(minimumMargin) || minimumMargin < 0 || minimumMargin > 1))
      fail('minimumMargin must be a finite number between 0 and 1');
    return collectInternal({ scope, maxAgeMs, signal }, minimumMargin, true);
  }

  return Object.freeze({ collect, diagnose });
}
