// Extracted from OpsPilot browser recovery ladder; platform adapters excluded.
// Missing mutation knowledge fails closed; audit failure cannot trigger replay.
const STAGE_FIXED = "fixed_contract";
const STAGE_PLAYWRIGHT = "playwright";
const STAGE_AGENT_BROWSER = "agent_browser_relocate";
const STAGE_STAGEHAND = "stagehand_self_heal";

export async function runBrowserRecoveryLadder({
  operation,
  playwrightFallback,
  agentBrowserRelocator,
  stagehandRelocator,
  executeRecoveredLocator,
  validateRecoveredLocator = () => false,
  audit = () => {},
  context = {}
} = {}) {
  context = structuredClone(context);
  assertRecoveryContract({ operation, executeRecoveredLocator, context });
  const attempts = [];

  const fixedResult = await attemptStage({
    stage: STAGE_FIXED,
    runner: operation,
    attempts,
    audit,
    context
  });
  if (fixedResult.ok) return complete(fixedResult.value, STAGE_FIXED, attempts);
  assertSafeToContinue(fixedResult.error, STAGE_FIXED);

  if (typeof playwrightFallback === "function") {
    const playwrightResult = await attemptStage({
      stage: STAGE_PLAYWRIGHT,
      runner: playwrightFallback,
      attempts,
      audit,
      context
    });
    if (playwrightResult.ok) return complete(playwrightResult.value, STAGE_PLAYWRIGHT, attempts);
    assertSafeToContinue(playwrightResult.error, STAGE_PLAYWRIGHT);
  }

  if (context.finalSubmission === true) {
    throw buildRecoveryError("browser_recovery_ai_forbidden_for_final_submission", {
      attempts,
      mutationState: "not_started",
      requiresReadbackOnly: true
    });
  }

  for (const [stage, relocator] of [
    [STAGE_AGENT_BROWSER, agentBrowserRelocator],
    [STAGE_STAGEHAND, stagehandRelocator]
  ]) {
    if (typeof relocator !== "function") continue;
    const relocation = await attemptStage({
      stage,
      runner: relocator,
      attempts,
      audit,
      context
    });
    if (!relocation.ok) {
      assertSafeToContinue(relocation.error, stage);
      continue;
    }
    const candidate = structuredClone(relocation.value);
    if (!candidate || (await validateRecoveredLocator(structuredClone(candidate), structuredClone(context))) !== true) {
      const error = buildRecoveryError("browser_recovered_locator_rejected", {
        stage,
        mutationState: "not_started"
      });
      attempts.push(summarizeAttempt(stage, false, error, "locator_validation"));
      await audit({ stage, status: "rejected", reason: error.code, context: sanitizeContext(context) });
      continue;
    }
    const execution = await attemptStage({
      stage,
      runner: () => executeRecoveredLocator(candidate, context),
      attempts,
      audit,
      context,
      phase: "playwright_execute_recovered_locator"
    });
    if (execution.ok) return complete(execution.value, stage, attempts);
    assertSafeToContinue(execution.error, stage);
  }

  const error = buildRecoveryError("browser_recovery_ladder_exhausted", {
    attempts,
    mutationState: "not_started"
  });
  throw error;
}

async function attemptStage({ stage, runner, attempts, audit, context, phase = "execute" }) {
  let value, failure;
  try { value = await runner(structuredClone(context)); }
  catch (error) { failure = error ?? new Error("unknown"); }
  const ok = failure === undefined;
  attempts.push(summarizeAttempt(stage, ok, failure, phase));
  // Audit failure after an operation must never enter the retry decision.
  try {
    await audit({ stage, phase, status: ok ? "ok" : "failed",
      reason: ok ? null : failure?.code || failure?.message || "unknown",
      mutationState: ok ? "possibly_started" : normalizeMutationState(failure),
      context: sanitizeContext(context) });
  } catch (cause) {
    throw buildRecoveryError("browser_recovery_audit_failed", {
      cause, attempts, mutationState: "possibly_started", requiresReadbackOnly: true
    });
  }
  return ok ? { ok: true, value } : { ok: false, error: failure };
}

function assertRecoveryContract({ operation, executeRecoveredLocator, context }) {
  if (typeof operation !== "function" || typeof executeRecoveredLocator !== "function") {
    throw buildRecoveryError("browser_recovery_contract_invalid", { mutationState: "not_started" });
  }
  if (!["read", "write"].includes(context.operationType)) {
    throw buildRecoveryError("browser_recovery_operation_type_required");
  }
  if (context.operationType === "write" && context.simulation !== true) {
    throw buildRecoveryError("browser_recovery_real_writes_disabled");
  }
  if (context.operationType === "write") {
    if (context.approved !== true || !context.approvalId || !context.expectedIdentity) {
      throw buildRecoveryError("browser_recovery_write_approval_required", {
        mutationState: "not_started"
      });
    }
  }
  if (context.finalSubmission === true && context.operationType !== "write") {
    throw buildRecoveryError("browser_recovery_final_submission_must_be_write", {
      mutationState: "not_started"
    });
  }
}

function assertSafeToContinue(error, stage) {
  const mutationState = normalizeMutationState(error);
  if (mutationState === "not_started") return;
  throw buildRecoveryError("browser_recovery_stopped_after_possible_mutation", {
    cause: error,
    failedStage: stage,
    mutationState,
    requiresReadbackOnly: true
  });
}

function normalizeMutationState(error) {
  const value = String(error?.mutationState || "possibly_started");
  return ["not_started", "possibly_started", "confirmed_started"].includes(value)
    ? value
    : "possibly_started";
}

function summarizeAttempt(stage, ok, error, phase) {
  return {
    stage,
    phase,
    status: ok ? "ok" : "failed",
    reason: ok ? null : error?.code || error?.message || "unknown",
    mutationState: ok ? "possibly_started" : normalizeMutationState(error)
  };
}

function complete(value, recoveredBy, attempts) {
  return {
    status: "completed",
    recoveredBy,
    value,
    attempts
  };
}

function sanitizeContext(context) {
  return {
    operationName: context.operationName || null,
    operationType: context.operationType || "read",
    platformId: context.platformId || null,
    storeName: context.storeName || null,
    approvalId: context.approvalId || null,
    expectedIdentity: structuredClone(context.expectedIdentity || null),
    finalSubmission: context.finalSubmission === true
  };
}

function buildRecoveryError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export const BROWSER_RECOVERY_STAGES = Object.freeze([
  STAGE_FIXED,
  STAGE_PLAYWRIGHT,
  STAGE_AGENT_BROWSER,
  STAGE_STAGEHAND
]);
