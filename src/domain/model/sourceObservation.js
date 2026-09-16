// src/domain/model/sourceObservation.js
// DS038 — Source observation contract (DS040 campaign extension).
//
// Pure, dependency-free normalization of a *trusted JSON* observation record.
// This module performs NO I/O, no network, no browser/executor access, no auth.
//
// IMPORTANT SEMANTICS: status 'READY' means only that the supplied record is
// *fresh*, *in the expected scope*, and structurally valid. It does NOT assert
// that the platform/store exists, that products are authentic, that the data is
// independently verified, or that any business action succeeded. There is
// deliberately no identityVerified / verification / auth flag.
//
// Trust model: callers pass plain data (parsed JSON or plain literals). This is
// not a sandbox for malicious Proxy objects; it does, however, refuse exotic
// shapes (accessors, symbols, custom prototypes, sparse arrays) *before*
// reading any value, so a hostile getter is never executed.
//
// DS040 adds four OPTIONAL product fields: campaignId (strict ID string),
// campaignPrice (integer), campaignEligible (boolean), campaignEnrolled
// (boolean). Absent or null each normalize to null. A missing/null boolean is
// NEVER coerced to false. The four fields are appended to a product only when
// at least one of them is present; products without any of them keep the exact
// pre-DS040 output shape. Coverage is unchanged.

const MODES = Object.freeze(['synthetic', 'host']);
const MAX_PRODUCTS = 10000;
const MAX_STRING_LEN = 128;
const MAX_AGE_LIMIT = 86400000;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const INPUT_KEYS = ['observationId', 'sourceId', 'mode', 'platformId', 'storeId', 'observedAt', 'products'];
const OPTION_KEYS = ['expectedScope', 'now', 'maxAgeMs'];
const SCOPE_KEYS = ['platformId', 'storeId'];
const PRODUCT_KEYS = [
  'id',
  'name',
  'price',
  'cost',
  'stock',
  'referencePrice',
  'warehouseAvailable',
  'campaignId',
  'campaignPrice',
  'campaignEligible',
  'campaignEnrolled',
];
const NUMERIC_KEYS = ['price', 'cost', 'stock', 'referencePrice', 'warehouseAvailable'];
const CAMPAIGN_KEYS = ['campaignId', 'campaignPrice', 'campaignEligible', 'campaignEnrolled'];

function fail(msg) {
  throw new TypeError(`normalizeSourceObservation: ${msg}`);
}

// --- structural guards -----------------------------------------------------

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Assert exact own-key set, all plain data properties, no symbols. Never invokes getters. */
function readPlainRecord(value, allowedKeys, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${label} must not have symbol keys`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    if (!allowedKeys.includes(key)) fail(`${label} has unknown key "${key}"`);
    const d = descriptors[key];
    if (!('value' in d)) fail(`${label}.${key} must be a data property, not an accessor`);
    out[key] = d.value;
  }
  return out;
}

/** Dense ordinary array: real Array, data-length, no holes/custom props/symbols/accessors. */
function readDenseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be an ordinary array`);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${label} must not have symbol keys`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !('value' in lengthDescriptor)) fail(`${label} must have a data length`);
  const length = lengthDescriptor.value;
  if (!Number.isInteger(length) || length < 0 || length > MAX_PRODUCTS) fail(`${label} has an invalid length`);
  const indexKeys = [];
  for (const key of keys) {
    if (key === 'length') continue;
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      fail(`${label} must not have custom property "${key}"`);
    }
    const d = descriptors[key];
    if (!('value' in d)) fail(`${label}[${key}] must be a data property, not an accessor`);
    indexKeys.push(key);
  }
  if (indexKeys.length !== length) fail(`${label} must be dense (no holes)`);
  const out = new Array(length);
  for (let i = 0; i < length; i += 1) out[i] = descriptors[String(i)].value;
  return out;
}

// --- scalar rules ----------------------------------------------------------

function readString(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (value.length === 0) fail(`${label} must be nonempty`);
  if (value.trim() !== value) fail(`${label} must not have leading/trailing whitespace`);
  if (value.length > MAX_STRING_LEN) fail(`${label} exceeds ${MAX_STRING_LEN} characters`);
  if (CONTROL_RE.test(value)) fail(`${label} must not contain control characters`);
  return value;
}

function readMode(value) {
  if (typeof value !== 'string' || !MODES.includes(value)) {
    fail(`mode must be one of ${MODES.join('|')}`);
  }
  return value;
}

/** Strict UTC ISO-8601 with millisecond precision; must round-trip through Date. */
function readTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an ISO timestamp string`);
  if (!ISO_MS_RE.test(value)) fail(`${label} must be ISO UTC with milliseconds`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(`${label} is not a valid date`);
  if (date.toISOString() !== value) fail(`${label} must be a normalized UTC timestamp`);
  return { text: value, ms: date.getTime() };
}

function readNonNegativeInt(value, label) {
  if (typeof value !== 'number') fail(`${label} must be a number`);
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
  if (value < 0) fail(`${label} must not be negative`);
  return value;
}

/** Absent or null -> null. Otherwise a safe nonnegative integer (zero preserved). */
function readOptionalInt(raw, present, label) {
  if (!present) return null;
  if (raw === null) return null;
  if (typeof raw === 'string') fail(`${label} must be a number, not a string`);
  return readNonNegativeInt(raw, label);
}

/**
 * Absent or null -> null. Otherwise a real boolean. A non-boolean is rejected;
 * it is never coerced, so a missing/null eligibility is never silently false.
 */
function readOptionalBool(raw, present, label) {
  if (!present) return null;
  if (raw === null) return null;
  if (typeof raw !== 'boolean') fail(`${label} must be a boolean, not a ${typeof raw}`);
  return raw;
}

/** Absent or null -> null. Otherwise a strict ID string (same rules as every other id). */
function readOptionalString(raw, present, label) {
  if (!present) return null;
  if (raw === null) return null;
  return readString(raw, label);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// --- main ------------------------------------------------------------------

export function normalizeSourceObservation(input, options) {
  // Options are required; a missing/absent bundle is invalid rather than an error leak.
  if (options === undefined || options === null) fail('options are required');
  const opts = readPlainRecord(options, OPTION_KEYS, 'options');
  if (!('expectedScope' in opts)) fail('options.expectedScope is required');
  if (!('now' in opts)) fail('options.now is required');
  if (!('maxAgeMs' in opts)) fail('options.maxAgeMs is required');

  const scope = readPlainRecord(opts.expectedScope, SCOPE_KEYS, 'options.expectedScope');
  readString(scope.platformId, 'options.expectedScope.platformId');
  readString(scope.storeId, 'options.expectedScope.storeId');

  const now = readTimestamp(opts.now, 'options.now');
  const maxAgeMs = readNonNegativeInt(opts.maxAgeMs, 'options.maxAgeMs');
  if (maxAgeMs < 1 || maxAgeMs > MAX_AGE_LIMIT) {
    fail(`options.maxAgeMs must be an integer in 1..${MAX_AGE_LIMIT}`);
  }

  // Full validation of the observation happens before any scope/freshness branch.
  const rec = readPlainRecord(input, INPUT_KEYS, 'input');

  const observationId = readString(rec.observationId, 'input.observationId');
  const sourceId = readString(rec.sourceId, 'input.sourceId');
  const mode = readMode(rec.mode);
  const platformId = readString(rec.platformId, 'input.platformId');
  const storeId = readString(rec.storeId, 'input.storeId');
  const observedAt = readTimestamp(rec.observedAt, 'input.observedAt');

  const rawProducts = readDenseArray(rec.products, 'input.products');
  if (rawProducts.length > MAX_PRODUCTS) fail(`input.products exceeds ${MAX_PRODUCTS} entries`);

  const products = [];
  const seenIds = new Set();
  for (let i = 0; i < rawProducts.length; i += 1) {
    const label = `input.products[${i}]`;
    const p = readPlainRecord(rawProducts[i], PRODUCT_KEYS, label);
    const id = readString(p.id, `${label}.id`);
    if (seenIds.has(id)) fail(`${label}.id duplicates an earlier product id`);
    seenIds.add(id);
    const name = 'name' in p ? readString(p.name, `${label}.name`) : id;
    const product = { id, name };
    for (const key of NUMERIC_KEYS) {
      product[key] = readOptionalInt(p[key], key in p, `${label}.${key}`);
    }

    // DS040: campaign fields are entirely optional. They are attached only when
    // at least one is present so that campaign-free products keep the old shape.
    const campaignPresent = CAMPAIGN_KEYS.some((key) => key in p);
    if (campaignPresent) {
      product.campaignId = readOptionalString(p.campaignId, 'campaignId' in p, `${label}.campaignId`);
      product.campaignPrice = readOptionalInt(p.campaignPrice, 'campaignPrice' in p, `${label}.campaignPrice`);
      product.campaignEligible = readOptionalBool(p.campaignEligible, 'campaignEligible' in p, `${label}.campaignEligible`);
      product.campaignEnrolled = readOptionalBool(p.campaignEnrolled, 'campaignEnrolled' in p, `${label}.campaignEnrolled`);
    }

    products.push(product);
  }

  // --- branching (all input already validated) ---
  let status = 'READY';
  let reason;
  if (platformId !== scope.platformId || storeId !== scope.storeId) {
    status = 'UNKNOWN';
    reason = 'scope_mismatch';
  } else if (observedAt.ms > now.ms) {
    status = 'UNKNOWN';
    reason = 'future_observation';
  } else if (now.ms - observedAt.ms > maxAgeMs) {
    status = 'UNKNOWN';
    reason = 'stale_observation';
  } else {
    reason = 'fresh_observation';
  }

  if (status === 'UNKNOWN') {
    // Never leak or use foreign/stale products.
    return deepFreeze({
      observationId,
      sourceId,
      mode,
      platformId,
      storeId,
      observedAt: observedAt.text,
      status,
      reason,
      products: [],
      coverage: null,
    });
  }

  const coverage = {
    productCount: products.length,
    priceKnownCount: products.filter((p) => p.price !== null).length,
    costKnownCount: products.filter((p) => p.cost !== null).length,
    stockKnownCount: products.filter((p) => p.stock !== null).length,
  };

  return deepFreeze({
    observationId,
    sourceId,
    mode,
    platformId,
    storeId,
    observedAt: observedAt.text,
    status,
    reason,
    products: products.map((p) => ({ ...p })),
    coverage,
  });
}
