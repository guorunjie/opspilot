import { createHash, randomUUID } from "node:crypto";

export const PLATFORM_ACTION_TYPES = Object.freeze({
  READ_AUTH_STATUS: "read_auth_status",
  READ_STORE_IDENTITY: "read_store_identity",
  READ_PRODUCT_CATALOG: "read_product_catalog",
  READ_ORDERS: "read_orders",
  READ_PRICE_INTEL: "read_price_intel",
  READ_CAMPAIGNS: "read_campaigns",
  READ_CAMPAIGN_PRODUCTS: "read_campaign_products",
  GENERATE_OPERATING_PLAN: "generate_operating_plan",
  UPDATE_ORIGINAL_PRICE: "update_original_price",
  UPDATE_ACTIVITY_PRICE: "update_activity_price",
  UPDATE_PRICES: "update_prices",
  CREATE_CAMPAIGN: "create_campaign",
  ENROLL_CAMPAIGN: "enroll_campaign",
  QUERY_PLATFORM_TASK: "query_platform_task",
  READBACK_PRODUCT_AND_CAMPAIGN: "readback_product_and_campaign",
  COMPENSATE_OR_ROLLBACK: "compensate_or_rollback",
  GENERATE_DAILY_REPORT: "generate_daily_report"
});

export const PLATFORM_ACTION_STATUSES = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  PLATFORM_PROCESSING: "platform_processing",
  PARTIAL_SUCCESS: "partial_success",
  AWAITING_READBACK: "awaiting_readback",
  READBACK_CONSISTENT: "readback_consistent",
  READBACK_INCONSISTENT: "readback_inconsistent",
  COMPENSATING: "compensating",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CIRCUIT_OPEN: "circuit_open"
});

export const PLATFORM_ACTION_STATUS_LABELS = Object.freeze({
  pending: "待执行",
  running: "执行中",
  platform_processing: "平台处理中",
  partial_success: "部分成功",
  awaiting_readback: "等待回读",
  readback_consistent: "回读一致",
  readback_inconsistent: "回读不一致",
  compensating: "补偿中",
  succeeded: "成功",
  failed: "失败",
  circuit_open: "已熔断"
});

export const PLATFORM_ACTION_AUTHORIZATION_LEVELS = Object.freeze({
  PREAUTHORIZED: "A",
  HUMAN_CONFIRMATION: "B",
  REJECTED: "C"
});

export const PLATFORM_ACTION_EXECUTOR_LEVELS = Object.freeze({
  VERIFIED_CONTRACT: "verified_contract",
  FIXED_PLAYWRIGHT_CDP: "fixed_playwright_cdp",
  AGENT_BROWSER: "agent_browser",
  GPT_STAGEHAND_CANDIDATE: "gpt_stagehand_candidate",
  HUMAN_TAKEOVER: "human_takeover"
});

const EXECUTOR_LADDER = Object.freeze(Object.values(PLATFORM_ACTION_EXECUTOR_LEVELS));

const ACTION_TYPE_SET = new Set(Object.values(PLATFORM_ACTION_TYPES));
const STATUS_SET = new Set(Object.values(PLATFORM_ACTION_STATUSES));
const AUTHORIZATION_SET = new Set(Object.values(PLATFORM_ACTION_AUTHORIZATION_LEVELS));
const EXECUTOR_SET = new Set(Object.values(PLATFORM_ACTION_EXECUTOR_LEVELS));
const TERMINAL_STATUSES = new Set([
  PLATFORM_ACTION_STATUSES.SUCCEEDED,
  PLATFORM_ACTION_STATUSES.FAILED,
  PLATFORM_ACTION_STATUSES.CIRCUIT_OPEN
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(["running", "failed", "circuit_open"]),
  running: new Set(["platform_processing", "partial_success", "awaiting_readback", "failed", "circuit_open"]),
  platform_processing: new Set(["partial_success", "awaiting_readback", "failed", "circuit_open"]),
  partial_success: new Set(["awaiting_readback", "readback_inconsistent", "compensating", "failed", "circuit_open"]),
  awaiting_readback: new Set(["platform_processing", "readback_consistent", "readback_inconsistent", "failed", "circuit_open"]),
  readback_consistent: new Set(["succeeded"]),
  readback_inconsistent: new Set(["compensating", "failed", "circuit_open"]),
  compensating: new Set(["awaiting_readback", "failed", "circuit_open"]),
  succeeded: new Set(),
  failed: new Set(),
  circuit_open: new Set()
});

export function createPlatformAction({
  actionId = randomUUID(),
  platformId,
  storeName,
  storeId = null,
  actionType,
  authorizationLevel,
  preauthorizationPolicyId = null,
  authorizationEvidenceId = null,
  executorLevel = null,
  idempotencyKey,
  immutableManifest = {},
  createdAt = new Date().toISOString(),
  expiresAt = null,
  metadata = null
} = {}) {
  const normalizedPlatformId = requiredText(platformId, "platformId");
  const normalizedStoreName = requiredText(storeName, "storeName");
  const normalizedActionType = requiredEnum(actionType, ACTION_TYPE_SET, "actionType");
  const normalizedAuthorization = requiredEnum(
    authorizationLevel,
    AUTHORIZATION_SET,
    "authorizationLevel"
  );
  const normalizedExecutor = executorLevel === null
    ? null
    : requiredEnum(executorLevel, EXECUTOR_SET, "executorLevel");
  const normalizedIdempotencyKey = requiredText(idempotencyKey, "idempotencyKey");
  if (normalizedAuthorization === PLATFORM_ACTION_AUTHORIZATION_LEVELS.PREAUTHORIZED
    && !String(preauthorizationPolicyId || "").trim()) {
    throw protocolError("PLATFORM_ACTION_PREAUTH_POLICY_REQUIRED", "A级自动执行必须绑定预授权策略编号。");
  }
  if (normalizedAuthorization === PLATFORM_ACTION_AUTHORIZATION_LEVELS.HUMAN_CONFIRMATION
    && !String(authorizationEvidenceId || "").trim()) {
    throw protocolError("PLATFORM_ACTION_CONFIRMATION_EVIDENCE_REQUIRED", "B级动作必须绑定当次人工确认凭据。");
  }
  const manifest = sanitizeManifest(immutableManifest);
  const action = {
    kind: "opspilot_platform_action",
    version: 1,
    actionId: requiredText(actionId, "actionId"),
    platformId: normalizedPlatformId,
    storeName: normalizedStoreName,
    storeId: nullableText(storeId),
    actionType: normalizedActionType,
    authorizationLevel: normalizedAuthorization,
    preauthorizationPolicyId: nullableText(preauthorizationPolicyId),
    authorizationEvidenceId: nullableText(authorizationEvidenceId),
    executorLevel: normalizedExecutor,
    idempotencyKey: normalizedIdempotencyKey,
    immutableManifest: manifest,
    manifestSha256: sha256Json(manifest),
    status: PLATFORM_ACTION_STATUSES.PENDING,
    statusLabel: PLATFORM_ACTION_STATUS_LABELS.pending,
    createdAt: isoTimestamp(createdAt, "createdAt"),
    updatedAt: isoTimestamp(createdAt, "createdAt"),
    expiresAt: expiresAt ? isoTimestamp(expiresAt, "expiresAt") : null,
    platformTaskId: null,
    mutationAttempted: false,
    terminal: false,
    reason: null,
    evidence: null,
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : null,
    history: []
  };
  return appendHistory(action, null, PLATFORM_ACTION_STATUSES.PENDING, {
    at: action.createdAt,
    reason: "动作已创建，等待确定性规则执行。",
    evidence: { manifestSha256: action.manifestSha256 }
  });
}

export function transitionPlatformAction(action, nextStatus, {
  at = new Date().toISOString(),
  reason = null,
  evidence = null,
  platformTaskId = undefined,
  executorLevel = undefined,
  mutationAttempted = undefined
} = {}) {
  assertPlatformAction(action);
  const normalizedStatus = requiredEnum(nextStatus, STATUS_SET, "nextStatus");
  if (!ALLOWED_TRANSITIONS[action.status]?.has(normalizedStatus)) {
    throw protocolError(
      "PLATFORM_ACTION_TRANSITION_INVALID",
      `不允许从 ${action.status} 转为 ${normalizedStatus}。`
    );
  }
  if (normalizedStatus === PLATFORM_ACTION_STATUSES.RUNNING
    && action.authorizationLevel === PLATFORM_ACTION_AUTHORIZATION_LEVELS.REJECTED) {
    throw protocolError("PLATFORM_ACTION_REJECTED_CANNOT_RUN", "C级动作已拒绝，禁止进入执行中。");
  }
  if (normalizedStatus === PLATFORM_ACTION_STATUSES.RUNNING
    && action.expiresAt
    && new Date(at).getTime() > new Date(action.expiresAt).getTime()) {
    throw protocolError("PLATFORM_ACTION_EXPIRED", "执行清单已经过期，禁止执行。");
  }
  if (normalizedStatus === PLATFORM_ACTION_STATUSES.SUCCEEDED
    && action.status !== PLATFORM_ACTION_STATUSES.READBACK_CONSISTENT) {
    throw protocolError("PLATFORM_ACTION_SUCCESS_REQUIRES_READBACK", "只有回读一致才能转为成功。");
  }
  if (normalizedStatus === PLATFORM_ACTION_STATUSES.READBACK_CONSISTENT && !hasExactReadbackEvidence(evidence)) {
    throw protocolError("PLATFORM_ACTION_READBACK_EVIDENCE_REQUIRED", "回读一致必须包含精确回读证据。");
  }
  if ([PLATFORM_ACTION_STATUSES.FAILED, PLATFORM_ACTION_STATUSES.CIRCUIT_OPEN].includes(normalizedStatus)
    && !String(reason || "").trim()) {
    throw protocolError("PLATFORM_ACTION_FAILURE_REASON_REQUIRED", "失败或熔断必须记录明确原因。");
  }
  const nextExecutor = executorLevel === undefined
    ? action.executorLevel
    : requiredEnum(executorLevel, EXECUTOR_SET, "executorLevel");
  if (action.executorLevel && nextExecutor !== action.executorLevel) {
    throw protocolError(
      "PLATFORM_ACTION_EXECUTOR_BYPASS",
      "执行器切换必须通过逐级失败升级接口，禁止直接替换。"
    );
  }
  if (!action.executorLevel && nextExecutor && nextExecutor !== EXECUTOR_LADDER[0]) {
    throw protocolError("PLATFORM_ACTION_EXECUTOR_BYPASS", "首次执行必须从已验证稳定契约开始。");
  }
  const next = {
    ...action,
    status: normalizedStatus,
    statusLabel: PLATFORM_ACTION_STATUS_LABELS[normalizedStatus],
    updatedAt: isoTimestamp(at, "at"),
    platformTaskId: platformTaskId === undefined ? action.platformTaskId : nullableText(platformTaskId),
    executorLevel: nextExecutor,
    mutationAttempted: mutationAttempted === undefined
      ? action.mutationAttempted
      : mutationAttempted === true,
    terminal: TERMINAL_STATUSES.has(normalizedStatus),
    reason: nullableText(reason),
    evidence: evidence === null || evidence === undefined ? null : structuredCloneSafe(evidence),
    history: [...action.history]
  };
  return appendHistory(next, action.status, normalizedStatus, { at: next.updatedAt, reason, evidence });
}

export function advancePlatformActionExecutor(action, nextExecutorLevel, {
  at = new Date().toISOString(),
  reason,
  evidence
} = {}) {
  assertPlatformAction(action);
  if (action.terminal) {
    throw protocolError("PLATFORM_ACTION_TERMINAL", "终态动作不能再升级执行器。");
  }
  const nextExecutor = requiredEnum(nextExecutorLevel, EXECUTOR_SET, "nextExecutorLevel");
  const currentIndex = EXECUTOR_LADDER.indexOf(action.executorLevel);
  const expectedIndex = currentIndex + 1;
  if (currentIndex < 0 || EXECUTOR_LADDER[expectedIndex] !== nextExecutor) {
    throw protocolError("PLATFORM_ACTION_EXECUTOR_ORDER_INVALID", "执行器只能按固定顺序逐级升级。");
  }
  if (!String(reason || "").trim() || evidence?.previousExecutorFailed !== true) {
    throw protocolError(
      "PLATFORM_ACTION_EXECUTOR_FAILURE_EVIDENCE_REQUIRED",
      "升级执行器必须记录上一级失败原因和证据。"
    );
  }
  const updatedAt = isoTimestamp(at, "at");
  return {
    ...action,
    executorLevel: nextExecutor,
    updatedAt,
    reason: nullableText(reason),
    evidence: structuredCloneSafe(evidence),
    history: [
      ...action.history,
      {
        sequence: action.history.length + 1,
        from: action.status,
        to: action.status,
        label: action.statusLabel,
        at: updatedAt,
        reason: nullableText(reason),
        evidence: structuredCloneSafe(evidence),
        executorFrom: action.executorLevel,
        executorTo: nextExecutor
      }
    ]
  };
}

export function completePlatformActionReadback(action, {
  at = new Date().toISOString(),
  evidence,
  reason = "精确回读与目标一致。"
} = {}) {
  const awaiting = action.status === PLATFORM_ACTION_STATUSES.AWAITING_READBACK
    ? action
    : transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.AWAITING_READBACK, { at });
  const consistent = transitionPlatformAction(awaiting, PLATFORM_ACTION_STATUSES.READBACK_CONSISTENT, {
    at,
    reason,
    evidence
  });
  return transitionPlatformAction(consistent, PLATFORM_ACTION_STATUSES.SUCCEEDED, { at, reason, evidence });
}

export function failPlatformActionAfterCompensation(action, {
  at = new Date().toISOString(),
  compensationVerified,
  evidence,
  reason
} = {}) {
  const compensating = action.status === PLATFORM_ACTION_STATUSES.COMPENSATING
    ? action
    : transitionPlatformAction(action, PLATFORM_ACTION_STATUSES.COMPENSATING, { at, reason, evidence });
  return transitionPlatformAction(
    compensating,
    compensationVerified === true
      ? PLATFORM_ACTION_STATUSES.FAILED
      : PLATFORM_ACTION_STATUSES.CIRCUIT_OPEN,
    { at, reason, evidence }
  );
}

export function assertPlatformAction(action) {
  if (action?.kind !== "opspilot_platform_action" || action.version !== 1) {
    throw protocolError("PLATFORM_ACTION_INVALID", "平台动作协议对象无效。");
  }
  requiredEnum(action.actionType, ACTION_TYPE_SET, "actionType");
  requiredEnum(action.status, STATUS_SET, "status");
  if (sha256Json(action.immutableManifest) !== action.manifestSha256) {
    throw protocolError("PLATFORM_ACTION_MANIFEST_TAMPERED", "不可变执行清单摘要不一致，已拒绝执行。");
  }
  if (!Array.isArray(action.history)) {
    throw protocolError("PLATFORM_ACTION_HISTORY_INVALID", "平台动作缺少状态历史。");
  }
  return action;
}

export function isPlatformActionTerminal(action) {
  assertPlatformAction(action);
  return TERMINAL_STATUSES.has(action.status);
}

export function isPlatformActionSuccessful(action) {
  assertPlatformAction(action);
  return action.status === PLATFORM_ACTION_STATUSES.SUCCEEDED
    && action.history.some((entry) => entry.to === PLATFORM_ACTION_STATUSES.READBACK_CONSISTENT);
}

function appendHistory(action, from, to, { at, reason, evidence }) {
  return {
    ...action,
    history: [
      ...action.history,
      {
        sequence: action.history.length + 1,
        from,
        to,
        label: PLATFORM_ACTION_STATUS_LABELS[to],
        at,
        reason: nullableText(reason),
        evidence: evidence === null || evidence === undefined ? null : structuredCloneSafe(evidence)
      }
    ]
  };
}

function sanitizeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("PLATFORM_ACTION_MANIFEST_INVALID", "不可变执行清单必须是对象。");
  }
  return structuredCloneSafe(value);
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hasExactReadbackEvidence(value) {
  return value !== null
    && typeof value === "object"
    && value.exact === true
    && Object.keys(value).length > 1;
}

function requiredText(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw protocolError("PLATFORM_ACTION_FIELD_REQUIRED", `${name} 不能为空。`);
  return normalized;
}

function nullableText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function requiredEnum(value, allowed, name) {
  const normalized = String(value ?? "").trim();
  if (!allowed.has(normalized)) {
    throw protocolError("PLATFORM_ACTION_ENUM_INVALID", `${name} 不受支持：${normalized || "空"}。`);
  }
  return normalized;
}

function isoTimestamp(value, name) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw protocolError("PLATFORM_ACTION_TIMESTAMP_INVALID", `${name} 不是有效时间。`);
  }
  return parsed.toISOString();
}

function protocolError(code, message) {
  return Object.assign(new Error(message), { code });
}
