// DS-029 Foundation connector descriptor contract (draft, additive Open Core).
// Pure JSON metadata only: no execution, no I/O, no dependencies, no config values.
const ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const OPERATIONS = ['read', 'write', 'compensate'];
const EXECUTIONS = ['local', 'host'];
const PROBE_STATUSES = ['available', 'unavailable', 'unknown'];
const isPlain = (v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isLabel = (v) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
const isVersion = (v) =>
  typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
const fail = (msg) => { throw new TypeError(msg); };

// Reject unknown keys, accessor properties, and non-plain containers before reading values.
function plainKeys(value, allowed, where) {
  if (!isPlain(value)) fail(`${where}: must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${where}: symbol keys are not allowed`);
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || desc.get || desc.set || !('value' in desc)) fail(`${where}: accessor property "${key}" is not allowed`);
    if (!allowed.includes(key)) fail(`${where}: unknown key "${key}"`);
  }
}
function denseArray(value, where, min, max) {
  if (!Array.isArray(value)) fail(`${where}: must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${where}: only Array.prototype is allowed`);
  const desc = Object.getOwnPropertyDescriptors(value);
  const length = desc.length && 'value' in desc.length ? desc.length.value : undefined;
  if (!Number.isInteger(length) || length < min || length > max) fail(`${where}: length must be ${min}..${max}`);
  for (const key of Reflect.ownKeys(desc)) {
    if (typeof key !== 'string') fail(`${where}: symbol keys are not allowed`);
    if (key === 'length') continue;
    if (!/^(0|[1-9]\d*)$/.test(key)) fail(`${where}: unexpected property "${key}"`);
    const i = Number(key);
    if (i >= length || String(i) !== key) fail(`${where}: unexpected property "${key}"`);
  }
  const out = [];
  for (let i = 0; i < length; i += 1) {
    const item = desc[i];
    if (!item) fail(`${where}: sparse array (hole at ${i})`);
    if (item.get || item.set || !('value' in item)) fail(`${where}: accessor property "${i}" is not allowed`);
    out.push(item.value);
  }
  return out;
}
function idList(value, where, min, max) {
  const list = denseArray(value, where, min, max).map((id, i) => {
    if (!isId(id)) fail(`${where}[${i}]: invalid identifier`);
    return id;
  });
  if (new Set(list).size !== list.length) fail(`${where}: duplicate identifiers`);
  return list;
}
function timeOrNull(value, where) {
  if (value === undefined) return null;
  if (typeof value !== 'string') fail(`${where}: must be an ISO UTC string`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(`${where}: malformed ISO UTC string`);
  return ms;
}

export function createConnectorManifest(input) {
  plainKeys(input, ['schemaVersion', 'id', 'label', 'version', 'platformIds', 'capabilities', 'requiredConfigKeys'], 'manifest');
  if (input.schemaVersion !== 1) fail('manifest.schemaVersion: must be 1');
  if (!isId(input.id)) fail('manifest.id: invalid identifier');
  if (!isLabel(input.label)) fail('manifest.label: invalid label');
  if (!isVersion(input.version)) fail('manifest.version: invalid version');
  const platformIds = idList(input.platformIds, 'manifest.platformIds', 1, 32);
  const caps = denseArray(input.capabilities, 'manifest.capabilities', 1, 64).map((cap, i) => {
    const where = `manifest.capabilities[${i}]`;
    plainKeys(cap, ['id', 'label', 'operation', 'execution', 'simulated'], where);
    if (!isId(cap.id)) fail(`${where}.id: invalid identifier`);
    if (!isLabel(cap.label)) fail(`${where}.label: invalid label`);
    if (!OPERATIONS.includes(cap.operation)) fail(`${where}.operation: must be read|write|compensate`);
    if (!EXECUTIONS.includes(cap.execution)) fail(`${where}.execution: must be local|host`);
    if (typeof cap.simulated !== 'boolean') fail(`${where}.simulated: must be boolean`);
    // Local write/compensate must be simulated; a real write may only be *declared* as host.
    // A declaration conveys no permission and is not authorization to execute.
    if (cap.execution === 'local' && cap.operation !== 'read' && cap.simulated !== true) {
      fail(`${where}: local ${cap.operation} must set simulated=true`);
    }
    return Object.freeze({ id: cap.id, label: cap.label, operation: cap.operation, execution: cap.execution, simulated: cap.simulated });
  });
  const ids = caps.map((c) => c.id);
  if (new Set(ids).size !== ids.length) fail('manifest.capabilities: duplicate identifiers');
  const requiredConfigKeys = idList(input.requiredConfigKeys, 'manifest.requiredConfigKeys', 0, 32);
  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    label: input.label,
    version: input.version,
    platformIds: Object.freeze(platformIds.slice()),
    capabilities: Object.freeze(caps),
    requiredConfigKeys: Object.freeze(requiredConfigKeys.slice()),
  });
}

export function assessConnectorReadiness(manifest, input) {
  if (!isPlain(input)) fail('readiness: must be a plain object');
  // Re-validate through the canonical constructor, even for an already-frozen manifest.
  const canonical = createConnectorManifest(manifest);
  // Validate the whole input, including any probe, before any early return.
  plainKeys(input, ['configuredKeys', 'probe', 'now', 'maxAgeMs'], 'readiness');
  const configuredKeys = idList(input.configuredKeys, 'readiness.configuredKeys', 0, 32);
  const now = timeOrNull(input.now, 'readiness.now');
  if (now === null) fail('readiness.now: required');
  if (!Number.isInteger(input.maxAgeMs) || input.maxAgeMs < 1 || input.maxAgeMs > 86400000) {
    fail('readiness.maxAgeMs: integer 1..86400000 required');
  }
  let probeStatus = null;
  let checkedAt = null;
  if (input.probe !== undefined) {
    const probe = input.probe;
    plainKeys(probe, ['status', 'checkedAt'], 'readiness.probe');
    if (!PROBE_STATUSES.includes(probe.status)) fail('readiness.probe.status: must be available|unavailable|unknown');
    probeStatus = probe.status;
    checkedAt = timeOrNull(probe.checkedAt, 'readiness.probe.checkedAt');
  }
  const result = (status, missing) => ({ status, missingKeys: Object.freeze(missing.slice()) });
  const missingKeys = canonical.requiredConfigKeys.filter((k) => !configuredKeys.includes(k));
  if (missingKeys.length > 0) return Object.freeze(result('NOT_CONFIGURED', missingKeys));
  if (checkedAt === null) return Object.freeze(result('UNKNOWN', []));
  if (checkedAt > now || now - checkedAt > input.maxAgeMs) return Object.freeze(result('UNKNOWN', []));
  if (probeStatus === 'unavailable') return Object.freeze(result('UNAVAILABLE', []));
  if (probeStatus === 'unknown') return Object.freeze(result('UNKNOWN', []));
  // READY is connectivity metadata only: not approval, not VERIFIED, not permission.
  return Object.freeze(result('READY', []));
}
