// test/hostExecutionBinding.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHostExecutionBinding,
  matchesHostExecutionBinding,
} from '../src/connector/hostExecutionBinding.js';

const STRING_FIELDS = [
  'hostId',
  'executionId',
  'platformId',
  'storeId',
  'actionId',
  'confirmationBindingSha256',
];

function validFields(overrides = {}) {
  return {
    version: 1,
    hostId: 'host-synthetic-1',
    executionId: 'exec-synthetic-1',
    platformId: 'platform-synthetic-1',
    storeId: 'store-synthetic-1',
    actionId: 'action-synthetic-1',
    confirmationBindingSha256: 'a'.repeat(64),
    ...overrides,
  };
}

test('accepts a valid binding and returns a frozen whitelist', () => {
  const binding = createHostExecutionBinding(validFields());
  assert.equal(Object.isFrozen(binding), true);
  assert.deepEqual(Object.keys(binding).sort(), [
    'actionId',
    'confirmationBindingSha256',
    'executionId',
    'hostId',
    'platformId',
    'storeId',
    'version',
  ]);
  assert.equal(binding.version, 1);
  for (const name of STRING_FIELDS) {
    assert.equal(binding[name], validFields()[name]);
  }
});

test('drops unknown keys so credentials do not propagate', () => {
  const binding = createHostExecutionBinding({
    ...validFields(),
    credential: 'synthetic-secret',
    token: 'synthetic-token',
    nested: { secret: 'synthetic' },
  });
  assert.equal('credential' in binding, false);
  assert.equal('token' in binding, false);
  assert.equal('nested' in binding, false);
  assert.equal(Object.keys(binding).length, 7);
});

test('does not mutate the source object', () => {
  const source = validFields({ extra: 'synthetic-extra' });
  const snapshot = JSON.parse(JSON.stringify(source));
  const binding = createHostExecutionBinding(source);
  assert.deepEqual(source, snapshot);
  assert.notEqual(binding, source);
  assert.equal(source.extra, 'synthetic-extra');
});

test('rejects non-object and array inputs', () => {
  for (const value of [null, undefined, 42, 'binding', true, [], [validFields()]]) {
    assert.throws(() => createHostExecutionBinding(value), TypeError);
  }
});

test('rejects version other than exactly 1', () => {
  for (const version of [0, 2, '1', null, undefined, 1.0 + 1, true]) {
    assert.throws(() => createHostExecutionBinding(validFields({ version })), TypeError);
  }
});

test('rejects each invalid required string field', () => {
  for (const name of STRING_FIELDS) {
    for (const bad of [null, undefined, 7, true, {}, '', '   ', ' padded ', '\ttab', 'line\nbreak', '\u0000nul', '\u001Fus', '\u007Fdel']) {
      assert.throws(
        () => createHostExecutionBinding(validFields({ [name]: bad })),
        TypeError,
        `${name} should reject`,
      );
    }
  }
});

test('rejects overlength fields', () => {
  for (const name of STRING_FIELDS) {
    const tooLong = 'a'.repeat(513);
    assert.throws(() => createHostExecutionBinding(validFields({ [name]: tooLong })), TypeError);
    const atLimit = 'a'.repeat(512);
    if (name !== 'confirmationBindingSha256')
      assert.doesNotThrow(() => createHostExecutionBinding(validFields({ [name]: atLimit })));
  }
});

test('rejects missing fields entirely', () => {
  for (const name of STRING_FIELDS) {
    const fields = validFields();
    delete fields[name];
    assert.throws(() => createHostExecutionBinding(fields), TypeError);
  }
});

test('matches returns true only for exact equality', () => {
  const expected = validFields();
  const observed = validFields();
  assert.equal(matchesHostExecutionBinding(expected, observed), true);
});

test('matches returns false for every single-field mismatch', () => {
  const expected = validFields();
  for (const name of STRING_FIELDS) {
    const observed = validFields({ [name]: name === 'confirmationBindingSha256' ? 'b'.repeat(64) : `${expected[name]}-other` });
    assert.equal(matchesHostExecutionBinding(expected, observed), false, name);
  }
});

test('matches returns false when either side is invalid', () => {
  assert.equal(matchesHostExecutionBinding(validFields(), null), false);
  assert.equal(matchesHostExecutionBinding(null, validFields()), false);
  assert.equal(matchesHostExecutionBinding(null, null), false);
  assert.equal(matchesHostExecutionBinding(validFields(), []), false);
  assert.equal(matchesHostExecutionBinding(validFields({ version: 2 }), validFields()), false);
  assert.equal(matchesHostExecutionBinding(validFields(), validFields({ hostId: ' x ' })), false);
  assert.equal(matchesHostExecutionBinding('binding', validFields()), false);
  assert.equal(matchesHostExecutionBinding(validFields(), undefined), false);
});

test('matches never throws and never infers status', () => {
  assert.equal(typeof matchesHostExecutionBinding(validFields(), validFields()), 'boolean');
  assert.equal(matchesHostExecutionBinding(validFields(), validFields({ executionId: 'exec--2' })), false);
});

test('reads each field once and does not infer verification from status', () => {
  let reads = 0;
  const input = validFields();
  Object.defineProperty(input, 'hostId', { get() { reads++; return reads === 1 ? 'host-1' : ''; } });
  assert.equal(createHostExecutionBinding(input).hostId, 'host-1');
  assert.equal(reads, 1);
  assert.equal('status' in createHostExecutionBinding(validFields({ status: 'VERIFIED' })), false);
});

test('requires fingerprint rather than a raw confirmation token', () => {
  for (const value of ['raw-token', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
    assert.throws(() => createHostExecutionBinding(validFields({ confirmationBindingSha256: value })), TypeError);
  }
  const legacy = validFields();
  delete legacy.confirmationBindingSha256;
  legacy.confirmationDigest = 'raw-token';
  assert.equal(matchesHostExecutionBinding(legacy, legacy), false);
  const safe = createHostExecutionBinding({ ...validFields(), confirmationDigest: 'raw-token' });
  assert.equal('confirmationDigest' in safe, false);
});
