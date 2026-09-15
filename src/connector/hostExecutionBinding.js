// Identity metadata only: not authorization, persistence or verification proof.
// src/connector/hostExecutionBinding.js
const WHITELIST = Object.freeze([
  'version',
  'hostId',
  'executionId',
  'platformId',
  'storeId',
  'actionId',
  'confirmationBindingSha256',
]);

const STRING_FIELDS = Object.freeze([
  'hostId',
  'executionId',
  'platformId',
  'storeId',
  'actionId',
  'confirmationBindingSha256',
]);

const MAX_LENGTH = 512;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function invalid(message) {
  throw new TypeError(`createHostExecutionBinding: ${message}`);
}

function requireIdentifier(name, value) {
  if (typeof value !== 'string') {
    invalid(`${name} must be a string`);
  }
  if (value.length === 0) {
    invalid(`${name} must be non-empty`);
  }
  if (value.length > MAX_LENGTH) {
    invalid(`${name} must be at most ${MAX_LENGTH} characters`);
  }
  if (value !== value.trim()) {
    invalid(`${name} must not have leading or trailing whitespace`);
  }
  if (CONTROL_CHARS.test(value)) {
    invalid(`${name} must not contain control characters`);
  }
}

export function createHostExecutionBinding(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('value must be a non-array object');
  }

  const source = value;

  if (source.version !== 1) {
    invalid('version must be exactly 1');
  }

  const binding = { version: 1 };
  for (const name of STRING_FIELDS) {
    const field = source[name];
    requireIdentifier(name, field);
    if (name === 'confirmationBindingSha256' && !/^[a-f0-9]{64}$/.test(field)) {
      invalid('confirmationBindingSha256 must be a SHA-256 fingerprint');
    }
    binding[name] = field;
  }

  return Object.freeze(binding);
}

export function matchesHostExecutionBinding(expected, observed) {
  let left;
  let right;
  try {
    left = createHostExecutionBinding(expected);
    right = createHostExecutionBinding(observed);
  } catch {
    return false;
  }

  for (const name of WHITELIST) {
    if (left[name] !== right[name]) {
      return false;
    }
  }
  return true;
}
