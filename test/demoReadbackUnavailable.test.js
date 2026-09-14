import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOfflineStoreDemo } from '../src/demo/offlineStoreDemo.js';
import { openStateStore } from '../src/storage/sqliteStateStore.js';

function assertUnknownAttempt(attempt) {
  assert.equal(attempt.status, 'UNKNOWN');
  assert.equal(attempt.code, 'target_unavailable');
  assert.equal(attempt.simulated, true);
  assert.equal(attempt.realPlatformVerified, false);
}

function assertVerifiedAttempt(attempt) {
  assert.equal(attempt.status, 'VERIFIED');
  assert.equal(attempt.code, 'exact_match');
  assert.equal(attempt.simulated, true);
  assert.equal(attempt.realPlatformVerified, false);
}

test('readback_unavailable: real SQLite reopen recovers state, persists outcome and history, then reset clears the session', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'offline-demo-sqlite-'));
  const sqliteFile = path.join(dir, 'state.sqlite');
  let store;

  // Closes the current handle and reopens the same file, rebuilding the demo model.
  const reopen = () => {
    store.close();
    store = openStateStore(sqliteFile, 'offline-demo');
    return createOfflineStoreDemo({ store });
  };

  try {
    store = openStateStore(sqliteFile, 'offline-demo');
    let demo = createOfflineStoreDemo({ store });

    // Initial state.
    assert.deepEqual(demo.snapshot().readbackAttempts, []);

    const diagnosis = demo.diagnose();
    assert.notEqual(diagnosis, null);
    assert.equal(typeof diagnosis, 'object');

    // Submit exactly once.
    const preview = demo.preview();
    assert.equal(typeof preview.id, 'string');
    assert.ok(preview.id.length > 0);

    demo.confirm({ previewId: preview.id, confirmed: true });
    demo.execute({ scenario: 'readback_unavailable' });

    const awaiting = demo.snapshot();
    assert.equal(awaiting.submissionCount, 1);
    assert.equal(awaiting.action.status, 'awaiting_readback');
    assert.equal(awaiting.action.evidence, null);
    assert.equal(awaiting.review, null);
    assert.deepEqual(awaiting.readbackAttempts, []);

    // First explicit readback: deterministic synthetic UNKNOWN, no invented observations.
    const first = demo.readback();
    assert.match(first.message, /未知/);
    assert.equal(first.action.status, 'awaiting_readback');
    assert.equal(first.action.evidence, null);
    assert.equal(first.review, null);
    assert.equal(first.readbackAttempts.length, 1);
    assertUnknownAttempt(first.readbackAttempts[0]);

    const beforeReopen = demo.snapshot();

    // Reopen #1: full state identical, scenario already consumed.
    demo = reopen();
    assert.deepEqual(demo.snapshot(), beforeReopen);
    assert.throws(() => demo.execute({ scenario: 'readback_unavailable' }), /重复/);

    // Second explicit readback succeeds deterministically; UNKNOWN history retained.
    const second = demo.readback();
    assert.equal(second.action.status, 'succeeded');
    assert.equal(second.review.matchedCount, 1);
    assert.equal(second.review.realPlatformVerified, false);
    assert.equal(second.submissionCount, 1);
    assert.equal(second.readbackAttempts.length, 2);
    assertUnknownAttempt(second.readbackAttempts[0]);
    assertVerifiedAttempt(second.readbackAttempts[1]);

    // Third readback is forbidden; execute stays forbidden as a duplicate.
    assert.throws(() => demo.readback(), /等待回读/);
    assert.throws(() => demo.execute({ scenario: 'readback_unavailable' }), /重复/);

    const afterSecond = demo.snapshot();

    // Reopen #2: outcome and full attempt history persisted.
    demo = reopen();
    assert.deepEqual(demo.snapshot(), afterSecond);
    assert.equal(demo.snapshot().action.status, 'succeeded');
    assert.equal(demo.snapshot().review.matchedCount, 1);
    assert.equal(demo.snapshot().readbackAttempts.length, 2);
    assertUnknownAttempt(demo.snapshot().readbackAttempts[0]);
    assertVerifiedAttempt(demo.snapshot().readbackAttempts[1]);

    // Reset starts a brand new session.
    const reset = demo.reset();
    assert.equal(typeof reset.sessionId, 'string');
    assert.notEqual(reset.sessionId, afterSecond.sessionId);

    const resetState = demo.snapshot();
    assert.equal(resetState.sessionId, reset.sessionId);
    assert.equal(resetState.action, null);
    assert.equal(resetState.review, null);
    assert.equal(resetState.submissionCount, 0);
    assert.deepEqual(resetState.readbackAttempts, []);
    assert.equal(resetState.executionScenario, null);
    demo = reopen();
    assert.deepEqual(demo.snapshot(), resetState);
  } finally {
    // Always close the current store BEFORE deleting only the directory we created.
    try {
      store?.close();
    } catch {
      // The handle may already be closed; cleanup below must still run.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in-memory model: normal scenario verifies on first readback with one VERIFIED attempt and blocks a repeat readback', () => {
  const demo = createOfflineStoreDemo({});
  demo.diagnose();

  assert.deepEqual(demo.snapshot().readbackAttempts, []);

  const preview = demo.preview();
  assert.equal(typeof preview.id, 'string');

  demo.confirm({ previewId: preview.id, confirmed: true });
  demo.execute({ scenario: 'normal' });

  const submitted = demo.snapshot();
  assert.equal(submitted.submissionCount, 1);
  assert.equal(submitted.action.status, 'awaiting_readback');
  assert.equal(submitted.action.evidence, null);
  assert.equal(submitted.review, null);
  assert.deepEqual(submitted.readbackAttempts, []);

  const state = demo.readback();
  assert.equal(state.action.status, 'succeeded');
  assert.equal(state.submissionCount, 1);
  assert.equal(state.readbackAttempts.length, 1);
  assertVerifiedAttempt(state.readbackAttempts[0]);
  assert.equal(state.review.matchedCount, 1);
  assert.equal(state.review.realPlatformVerified, false);

  // A second readback is rejected.
  assert.throws(() => demo.readback(), /等待回读/);
});
