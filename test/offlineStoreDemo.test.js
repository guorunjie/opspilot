import test from "node:test";
import assert from "node:assert/strict";
import { createOfflineStoreDemo } from "../src/demo/offlineStoreDemo.js";

test("demo requires diagnosis, preview and explicit confirmation before simulated execution", () => {
  const demo = createOfflineStoreDemo();
  assert.equal(demo.snapshot().diagnosis, null);
  assert.throws(() => demo.execute(), /确认/);
  demo.diagnose();
  const preview = demo.preview();
  assert.equal(preview.items.length, 1);
  assert.equal(preview.excluded[0].reason, "missing_cost");
  assert.throws(() => demo.confirm({ previewId: preview.id, confirmed: false }), /确认/);
  demo.confirm({ previewId: preview.id, confirmed: true });
  assert.equal(demo.execute().action.status, "awaiting_readback");
  assert.equal(demo.snapshot().review, null);
  const result = demo.readback();
  assert.equal(result.action.status, "succeeded");
  assert.equal(result.review.simulated, true);
  assert.equal(result.review.realPlatformVerified, false);
});

test("unknown simulated submission never repeats before readback and reset invalidates approval", () => {
  const demo = createOfflineStoreDemo();
  demo.diagnose();
  const preview = demo.preview();
  demo.confirm({ previewId: preview.id, confirmed: true });
  demo.execute({ scenario: "response_lost" });
  assert.throws(() => demo.execute(), /回读/);
  assert.equal(demo.snapshot().submissionCount, 1);
  assert.equal(demo.readback().review.matchedCount, 1);
  demo.reset();
  assert.equal(demo.snapshot().diagnosis, null);
  assert.equal(demo.snapshot().submissionCount, 0);
  demo.diagnose();
  demo.preview();
  assert.throws(() => demo.confirm({ previewId: preview.id, confirmed: true }), /失效/);
});

test("readback mismatch remains unresolved and does not invent profit gains", () => {
  const demo = createOfflineStoreDemo();
  demo.diagnose();
  const preview = demo.preview();
  demo.confirm({ previewId: preview.id, confirmed: true });
  demo.execute({ scenario: "mismatch" });
  const state = demo.readback();
  assert.equal(state.action.status, "readback_inconsistent");
  assert.equal(state.review.matchedCount, 0);
  assert.equal(state.review.actualProfitImpact, null);
  assert.throws(() => demo.execute(), /回读/);
});

test("demo instances and returned snapshots never share mutable state", () => {
  const a = createOfflineStoreDemo();
  const b = createOfflineStoreDemo();
  a.diagnose();
  const snapshot = a.snapshot();
  snapshot.products[0].cost = 0;
  assert.notEqual(a.snapshot().products[0].cost, 0);
  assert.equal(b.snapshot().diagnosis, null);
});
