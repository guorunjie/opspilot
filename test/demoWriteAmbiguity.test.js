// test/demoWriteAmbiguity.test.js
//
// Scope note: this is NOT a real exactly-once proof. The store double below is a
// single-process mock in which the mock target and mock task live in the same
// in-memory record, so it only shows the demo model writes through the injected
// store and re-reads stored state after a lost response. No actual platform is
// involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineStoreDemo } from '../src/demo/offlineStoreDemo.js';

// Closure-backed, revision-checked in-memory store double.
function createMemoryStore() {
  const records = new Map();
  const orderedKeys = [];
  let pendingFault = null;
  let saveCalls = 0;

  function commit(key, value, expectedRevision) {
    const current = records.has(key) ? records.get(key).revision : 0;
    if (current !== expectedRevision) {
      throw new Error('revision conflict');
    }
    const revision = expectedRevision + 1;
    records.set(key, { revision, value: structuredClone(value) });
    if (!orderedKeys.includes(key)) orderedKeys.push(key);
    return revision;
  }

  return {
    read(key) {
      return records.has(key) ? structuredClone(records.get(key)) : null;
    },
    save(key, value, expectedRevision) {
      saveCalls += 1;
      if (pendingFault !== null) {
        const fault = pendingFault;
        pendingFault = null;
        commit(key, value, expectedRevision); // the stored write lands ...
        throw fault; // ... but the response never makes it back.
      }
      return commit(key, value, expectedRevision);
    },
    armCommitThenThrow(message) {
      pendingFault = new Error(message);
    },
    hasArmedFault() {
      return pendingFault !== null;
    },
    saveCalls() {
      return saveCalls;
    },
    keys() {
      return [...orderedKeys];
    },
  };
}

function driveToConfirmed(model) {
  model.diagnose();
  const preview = model.preview();
  model.confirm({ previewId: preview.id, confirmed: true });
}

test('a save that commits then loses the response is recovered from stored state', () => {
  const store = createMemoryStore();
  const model = createOfflineStoreDemo({ store });
  driveToConfirmed(model);

  store.armCommitThenThrow('response lost after commit');
  assert.throws(
    () => model.execute({ scenario: 'response_lost' }),
    (error) => error instanceof Error && error.message === 'response lost after commit'
  );
  assert.equal(store.hasArmedFault(), false, 'the injected fault must be one-shot');

  // The original instance is poisoned: no more commands, and above all no more writes.
  const callsAfterFault = store.saveCalls();
  assert.throws(
    () => model.execute({ scenario: 'response_lost' }),
    (error) => error instanceof Error && /重新打开|重复/.test(error.message)
  );
  assert.equal(store.saveCalls(), callsAfterFault, 'poisoned instance must not save again');

  // Reopen against the SAME store; every field below is read back from the record.
  const reopened = createOfflineStoreDemo({ store });
  const [key] = store.keys();
  const persisted = store.read(key);
  assert.ok(persisted, 'the faulted save committed a stored record');

  const afterReopen = reopened.snapshot();
  assert.equal(afterReopen.action.status, 'awaiting_readback');
  assert.equal(afterReopen.submissionCount, 1);
  assert.equal(afterReopen.review, null);
  assert.equal(persisted.value.state.action.status, afterReopen.action.status);
  assert.equal(persisted.value.state.submissionCount, afterReopen.submissionCount);

  // The recovered instance refuses a duplicate execute without touching the store.
  const callsBeforeDuplicate = store.saveCalls();
  assert.throws(
    () => reopened.execute({ scenario: 'response_lost' }),
    (error) => error instanceof Error && /重新打开|重复/.test(error.message)
  );
  assert.equal(store.saveCalls(), callsBeforeDuplicate);
  assert.equal(reopened.snapshot().action.status, 'awaiting_readback');

  // The one matching readback settles the submission.
  reopened.readback();
  const settled = reopened.snapshot();
  assert.equal(settled.action.status, 'succeeded');
  assert.equal(settled.submissionCount, 1);
  assert.equal(settled.review.realPlatformVerified, false);
});

test('a model holding a stale revision cannot overwrite a committed submission', () => {
  const store = createMemoryStore();

  const modelA = createOfflineStoreDemo({ store });
  driveToConfirmed(modelA);

  const modelB = createOfflineStoreDemo({ store });
  assert.equal(modelB.snapshot().submissionCount, 0);

  const [key] = store.keys();
  modelA.execute({ scenario: 'response_lost' });
  const committed = store.read(key);
  assert.equal(committed.value.state.action.status, 'awaiting_readback');
  assert.equal(committed.value.state.submissionCount, 1);

  const beforeBAttempt = store.read(key);
  assert.throws(
    () => modelB.execute({ scenario: 'response_lost' }),
    (error) => error instanceof Error && error.message === 'revision conflict'
  );

  // B must not have altered the record committed by A in any way.
  const afterBAttempt = store.read(key);
  assert.deepEqual(afterBAttempt, beforeBAttempt);
  assert.equal(JSON.stringify(afterBAttempt), JSON.stringify(beforeBAttempt));

  // B is now poisoned and can neither retry nor write.
  const callsAfterConflict = store.saveCalls();
  assert.throws(
    () => modelB.execute({ scenario: 'response_lost' }),
    (error) => error instanceof Error && /重新打开|重复/.test(error.message)
  );
  assert.equal(store.saveCalls(), callsAfterConflict);
  assert.deepEqual(store.read(key), beforeBAttempt);

  // A brand new reader sees exactly one committed submission, then settles it.
  const modelC = createOfflineStoreDemo({ store });
  assert.equal(modelC.snapshot().action.status, 'awaiting_readback');
  assert.equal(modelC.snapshot().submissionCount, 1);

  modelC.readback();
  assert.equal(modelC.snapshot().action.status, 'succeeded');
  assert.equal(modelC.snapshot().submissionCount, 1);
  assert.equal(modelC.snapshot().review.realPlatformVerified, false);
});
