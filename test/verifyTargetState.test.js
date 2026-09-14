import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyTargetState } from '../src/verification/verifyTargetState.js';

// Synthetic fixtures only: this suite compares caller-supplied values and makes
// no claim about provenance, retrieval, or real-platform success.

const scope = (overrides = {}) => ({
  planId: 'plan-1',
  connectorId: 'connector-1',
  storeId: 'store-1',
  ...overrides,
});

const expectedOf = (...pairs) => pairs.map(([targetId, value]) => ({ targetId, value }));

const readbackOf = (overrides = {}, ...pairs) => ({
  ...scope(),
  items: pairs.map(([targetId, value]) => ({ targetId, value })),
  ...overrides,
});

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const expectUnknown = (result, targetIds) => {
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.exact, false);
  for (const targetId of targetIds) {
    const item = result.items.find((entry) => entry.targetId === targetId);
    assert.ok(item, `expected a result item for ${targetId}`);
    assert.equal(item.status, 'UNKNOWN');
  }
  assert.ok(result.items.every((item) => item.status === 'UNKNOWN'));
};

test('returns VERIFIED and exact true when every expected target matches', () => {
  const expected = expectedOf(['t1', 0], ['t2', 42]);
  const readback = readbackOf({}, ['t1', 0], ['t2', 42]);

  const result = verifyTargetState({ ...scope(), expected, readback });

  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.exact, true);
  assert.deepEqual(result.items, [
    { targetId: 't1', expected: 0, observed: 0, status: 'VERIFIED' },
    { targetId: 't2', expected: 42, observed: 42, status: 'VERIFIED' },
  ]);
});

test('returns PARTIALLY_VERIFIED when some observed values differ', () => {
  const expected = expectedOf(['t1', 1], ['t2', 2], ['t3', 3]);
  const readback = readbackOf({}, ['t1', 1], ['t2', 99], ['t3', 3]);

  const result = verifyTargetState({ ...scope(), expected, readback });

  assert.equal(result.status, 'PARTIALLY_VERIFIED');
  assert.equal(result.exact, false);
  assert.deepEqual(result.items.map((item) => item.status), ['VERIFIED', 'FAILED', 'VERIFIED']);
  assert.equal(result.items[1].observed, 99);
});

test('returns PARTIALLY_VERIFIED with UNKNOWN when a target is missing from readback', () => {
  const expected = expectedOf(['t1', 5], ['t2', 6]);
  const readback = readbackOf({}, ['t1', 5]);

  const result = verifyTargetState({ ...scope(), expected, readback });

  assert.equal(result.status, 'PARTIALLY_VERIFIED');
  assert.equal(result.exact, false);
  assert.deepEqual(result.items, [
    { targetId: 't1', expected: 5, observed: 5, status: 'VERIFIED' },
    { targetId: 't2', expected: 6, observed: null, status: 'UNKNOWN' },
  ]);
});

test('returns FAILED and exact false when all targets mismatch', () => {
  const expected = expectedOf(['t1', 1], ['t2', 2]);
  const readback = readbackOf({}, ['t1', 10], ['t2', 20]);

  const result = verifyTargetState({ ...scope(), expected, readback });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.exact, false);
  assert.deepEqual(result.items.map((item) => item.status), ['FAILED', 'FAILED']);
  assert.deepEqual(result.items.map((item) => item.observed), [10, 20]);
});

test('returns UNKNOWN when every expected target is missing from readback', () => {
  const expected = expectedOf(['t1', 1], ['t2', 2]);
  const readback = readbackOf();

  const result = verifyTargetState({ ...scope(), expected, readback });

  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.exact, false);
  assert.deepEqual(result.items, [
    { targetId: 't1', expected: 1, observed: null, status: 'UNKNOWN' },
    { targetId: 't2', expected: 2, observed: null, status: 'UNKNOWN' },
  ]);
});

test('treats zero as valid and null/string/NaN as invalid, not zero', () => {
  const expected = expectedOf(['zero', 0], ['nullish', 0], ['stringy', 0], ['nan', 0]);
  const readback = readbackOf(
    {},
    ['zero', 0],
    ['nullish', null],
    ['stringy', '0'],
    ['nan', Number.NaN],
  );

  const result = verifyTargetState({ ...scope(), expected, readback });

  assert.equal(result.status, 'PARTIALLY_VERIFIED');
  assert.equal(result.exact, false);
  assert.deepEqual(result.items.map((item) => item.status), [
    'VERIFIED',
    'UNKNOWN',
    'UNKNOWN',
    'UNKNOWN',
  ]);
  assert.deepEqual(result.items.map((item) => item.observed), [0, null, null, null]);
});

test('returns UNKNOWN for all items when readback scope does not match', () => {
  const expected = expectedOf(['t1', 1], ['t2', 2]);

  for (const key of ['planId', 'connectorId', 'storeId']) {
    const readback = readbackOf({ [key]: 'different-scope' }, ['t1', 1], ['t2', 2]);
    const result = verifyTargetState({ ...scope(), expected, readback });
    expectUnknown(result, ['t1', 't2']);
  }
});

test('returns UNKNOWN for the whole result on duplicate or unexpected readback targets', () => {
  const expected = expectedOf(['t1', 1], ['t2', 2]);

  const duplicate = readbackOf({}, ['t1', 1], ['t1', 1]);
  const duplicateResult = verifyTargetState({ ...scope(), expected, readback: duplicate });
  expectUnknown(duplicateResult, ['t1', 't2']);

  const unexpected = readbackOf({}, ['t1', 1], ['t2', 2], ['t9', 9]);
  const unexpectedResult = verifyTargetState({ ...scope(), expected, readback: unexpected });
  expectUnknown(unexpectedResult, ['t1', 't2']);
});

test('throws on malformed expected input', () => {
  const readback = readbackOf({}, ['t1', 1]);
  const base = { ...scope(), readback };

  assert.throws(() => verifyTargetState({ ...base, expected: [] }));
  assert.throws(() => verifyTargetState({ ...base, expected: 't1' }));
  assert.throws(() => verifyTargetState({ ...base, expected: null }));
  assert.throws(() =>
    verifyTargetState({
      ...base,
      expected: [
        { targetId: 't1', value: 1 },
        { targetId: 't1', value: 1 },
      ],
    }),
  );
  assert.throws(() => verifyTargetState({ ...base, expected: [{ targetId: 't1', value: -1 }] }));
  assert.throws(() => verifyTargetState({ ...base, expected: [{ targetId: 't1', value: 1.5 }] }));
  assert.throws(() =>
    verifyTargetState({ ...base, expected: [{ targetId: 't1', value: Number.MAX_SAFE_INTEGER + 1 }] }),
  );
  assert.throws(() => verifyTargetState({ ...base, expected: [{ targetId: '', value: 1 }] }));
  assert.throws(() => verifyTargetState({ ...base, expected: [{ targetId: 't1' }] }));
});

test('throws when required ids are empty or not strings', () => {
  const expected = expectedOf(['t1', 1]);
  const readback = readbackOf({}, ['t1', 1]);

  for (const planId of ['', null, 7, undefined]) {
    assert.throws(() => verifyTargetState({ ...scope({ planId }), expected, readback }));
  }
  assert.throws(() => verifyTargetState({ ...scope({ connectorId: '' }), expected, readback }));
  assert.throws(() => verifyTargetState({ ...scope({ storeId: 0 }), expected, readback }));
  assert.throws(() =>
    verifyTargetState({ connectorId: 'connector-1', storeId: 'store-1', expected, readback }),
  );
});

test('returns UNKNOWN for all items when readback structure is invalid', () => {
  const expected = expectedOf(['t1', 1], ['t2', 2]);
  const cases = [
    { ...scope(), items: 'not-an-array' },
    { ...scope() },



    { ...scope(), items: [{ targetId: 't1', value: 1 }, { targetId: '', value: 2 }] },
    { ...scope(), items: [{ targetId: 't1', value: 1 }, null] },

  ];

  for (const readback of cases) {
    const result = verifyTargetState({ ...scope(), expected, readback });
    expectUnknown(result, ['t1', 't2']);
  }
});

test('does not mutate inputs and does not alias input values into the result', () => {
  const expected = expectedOf(['t1', 1], ['t2', 2]);
  const readback = readbackOf({}, ['t1', 1], ['t2', 2]);
  const expectedSnapshot = structuredClone(expected);
  const readbackSnapshot = structuredClone(readback);

  deepFreeze(expected);
  deepFreeze(readback);

  const result = verifyTargetState({ ...scope(), expected, readback });
  assert.deepEqual(expected, expectedSnapshot);
  assert.deepEqual(readback, readbackSnapshot);

  result.items[0].targetId = 'mutated';
  result.items[0].expected = 999;
  result.items[0].observed = 123;

  assert.deepEqual(expected, expectedSnapshot);
  assert.deepEqual(readback, readbackSnapshot);
});

test('invalid observations preserve valid siblings; unknown dominates when none match', () => {
  for (const invalid of [-1, 2.5, true, undefined, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = verifyTargetState({ ...scope(), expected: expectedOf(['t1', 1], ['t2', 2]),
      readback: readbackOf({}, ['t1', 1], ['t2', invalid]) });
    assert.equal(result.status, 'PARTIALLY_VERIFIED');
    assert.equal(result.items[1].observed, null);
  }
  const result = verifyTargetState({ ...scope(), expected: expectedOf(['t1', 1], ['t2', 2]),
    readback: readbackOf({}, ['t1', 9]) });
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(result.items.map(item => item.status), ['FAILED', 'UNKNOWN']);
});

test('sparse arrays and absent readback fail closed', () => {
  assert.throws(() => verifyTargetState({ ...scope(), expected: new Array(1) }));
  for (const readback of [undefined, null, { ...scope(), items: new Array(1) }]) {
    expectUnknown(verifyTargetState({ ...scope(), expected: expectedOf(['t1', 0]), readback }), ['t1']);
  }
});
