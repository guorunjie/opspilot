import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_ACTION_AUTHORIZATION_LEVELS,
  PLATFORM_ACTION_EXECUTOR_LEVELS,
  PLATFORM_ACTION_STATUSES,
  PLATFORM_ACTION_STATUS_LABELS,
  PLATFORM_ACTION_TYPES,
  advancePlatformActionExecutor,
  completePlatformActionReadback,
  createPlatformAction,
  failPlatformActionAfterCompensation,
  isPlatformActionSuccessful,
  isPlatformActionTerminal,
  transitionPlatformAction
} from "../src/domain/model/platformActionProtocol.js";

test("platform action protocol exposes every required cross-platform action", () => {
  assert.deepEqual(new Set(Object.values(PLATFORM_ACTION_TYPES)), new Set([
    "read_auth_status",
    "read_store_identity",
    "read_product_catalog",
    "read_orders",
    "read_price_intel",
    "read_campaigns",
    "read_campaign_products",
    "generate_operating_plan",
    "update_original_price",
    "update_activity_price",
    "update_prices",
    "create_campaign",
    "enroll_campaign",
    "query_platform_task",
    "readback_product_and_campaign",
    "compensate_or_rollback",
    "generate_daily_report"
  ]));
  assert.deepEqual(new Set(Object.keys(PLATFORM_ACTION_STATUS_LABELS)), new Set(Object.values(PLATFORM_ACTION_STATUSES)));
});

test("platform action can only succeed after exact readback evidence", () => {
  let action = createFixtureAction();
  action = transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.RUNNING, {
    executorLevel: PLATFORM_ACTION_EXECUTOR_LEVELS.VERIFIED_CONTRACT
  });
  assert.throws(
    () => transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.SUCCEEDED),
    (error) => error.code === "PLATFORM_ACTION_TRANSITION_INVALID"
  );
  action = completePlatformActionReadback(action, {
    evidence: { exact: true, productCode: "SKU-1", actualPrice: 20 }
  });
  assert.equal(action.status, PLATFORM_ACTION_STATUSES.SUCCEEDED);
  assert.equal(action.statusLabel, "成功");
  assert.equal(isPlatformActionSuccessful(action), true);
  assert.equal(isPlatformActionTerminal(action), true);
});

test("platform action refuses readback-consistent without evidence", () => {
  let action = createFixtureAction();
  action = transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.RUNNING);
  action = transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.AWAITING_READBACK);
  assert.throws(
    () => transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.READBACK_CONSISTENT),
    (error) => error.code === "PLATFORM_ACTION_READBACK_EVIDENCE_REQUIRED"
  );
});

test("platform action requires exact readback evidence rather than any non-empty object", () => {
  let action = createFixtureAction();
  action = transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.RUNNING);
  action = transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.AWAITING_READBACK);
  assert.throws(
    () => transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.READBACK_CONSISTENT, {
      evidence: { productCode: "SKU-1" }
    }),
    (error) => error.code === "PLATFORM_ACTION_READBACK_EVIDENCE_REQUIRED"
  );
});

test("verified rollback remains failed and unverified rollback opens the circuit", () => {
  const verified = failPlatformActionAfterCompensation(readbackMismatchAction(), {
    compensationVerified: true,
    reason: "目标未生效，已精确恢复写前状态。",
    evidence: { rollbackExact: true }
  });
  assert.equal(verified.status, PLATFORM_ACTION_STATUSES.FAILED);
  assert.equal(isPlatformActionSuccessful(verified), false);

  const unverified = failPlatformActionAfterCompensation(readbackMismatchAction(), {
    compensationVerified: false,
    reason: "补偿回读仍不一致，已熔断门店动作。",
    evidence: { rollbackExact: false }
  });
  assert.equal(unverified.status, PLATFORM_ACTION_STATUSES.CIRCUIT_OPEN);
  assert.equal(unverified.statusLabel, "已熔断");
});

test("preauthorized action requires an auditable policy id", () => {
  assert.throws(
    () => createFixtureAction({
      authorizationLevel: PLATFORM_ACTION_AUTHORIZATION_LEVELS.PREAUTHORIZED,
      preauthorizationPolicyId: null
    }),
    (error) => error.code === "PLATFORM_ACTION_PREAUTH_POLICY_REQUIRED"
  );
});

test("human-confirmed action requires current confirmation evidence", () => {
  assert.throws(
    () => createFixtureAction({ authorizationEvidenceId: null }),
    (error) => error.code === "PLATFORM_ACTION_CONFIRMATION_EVIDENCE_REQUIRED"
  );
});

test("rejected and expired actions cannot start", () => {
  const rejected = createFixtureAction({
    authorizationLevel: PLATFORM_ACTION_AUTHORIZATION_LEVELS.REJECTED,
    authorizationEvidenceId: null
  });
  assert.throws(
    () => transitionPlatformAction(rejected, PLATFORM_ACTION_STATUSES.RUNNING),
    (error) => error.code === "PLATFORM_ACTION_REJECTED_CANNOT_RUN"
  );

  const expired = createFixtureAction({ expiresAt: "2026-08-01T01:01:00.000Z" });
  assert.throws(
    () => transitionPlatformAction(expired, PLATFORM_ACTION_STATUSES.RUNNING, {
      at: "2026-08-01T01:02:00.000Z"
    }),
    (error) => error.code === "PLATFORM_ACTION_EXPIRED"
  );
});

test("immutable manifest tampering is rejected", () => {
  const action = createFixtureAction();
  action.immutableManifest.products[0].targetPrice = 0.01;
  assert.throws(
    () => transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.RUNNING),
    (error) => error.code === "PLATFORM_ACTION_MANIFEST_TAMPERED"
  );
});

test("executor recovery follows the fixed ladder and requires prior failure evidence", () => {
  let action = createFixtureAction({ executorLevel: PLATFORM_ACTION_EXECUTOR_LEVELS.VERIFIED_CONTRACT });
  action = transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.RUNNING);
  assert.throws(
    () => advancePlatformActionExecutor(action, PLATFORM_ACTION_EXECUTOR_LEVELS.AGENT_BROWSER, {
      reason: "接口和固定选择器都失败。",
      evidence: { previousExecutorFailed: true }
    }),
    (error) => error.code === "PLATFORM_ACTION_EXECUTOR_ORDER_INVALID"
  );
  action = advancePlatformActionExecutor(action, PLATFORM_ACTION_EXECUTOR_LEVELS.FIXED_PLAYWRIGHT_CDP, {
    reason: "已验证接口契约漂移。",
    evidence: { previousExecutorFailed: true, contractId: "jd-price-v1" }
  });
  assert.equal(action.executorLevel, PLATFORM_ACTION_EXECUTOR_LEVELS.FIXED_PLAYWRIGHT_CDP);
});

function createFixtureAction(overrides = {}) {
  return createPlatformAction({
    actionId: "action-1",
    platformId: "jd",
    storeName: "京东测试门店",
    storeId: "JD-1",
    actionType: PLATFORM_ACTION_TYPES.UPDATE_PRICES,
    authorizationLevel: PLATFORM_ACTION_AUTHORIZATION_LEVELS.HUMAN_CONFIRMATION,
    authorizationEvidenceId: "confirmation-digest-1",
    idempotencyKey: "immutable-confirmation:SKU-1",
    immutableManifest: {
      snapshotSha256: "a".repeat(64),
      costVersion: "cost-v1",
      ruleVersion: "rule-v1",
      products: [{ productCode: "SKU-1", targetPrice: 20 }]
    },
    createdAt: "2026-08-01T01:00:00.000Z",
    ...overrides
  });
}

function readbackMismatchAction() {
  let action = createFixtureAction();
  action = transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.RUNNING);
  action = transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.PLATFORM_PROCESSING, {
    mutationAttempted: true,
    platformTaskId: "TASK-1"
  });
  action = transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.AWAITING_READBACK);
  return transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.READBACK_INCONSISTENT, {
    reason: "目标价回读不一致。",
    evidence: { exact: false }
  });
}
