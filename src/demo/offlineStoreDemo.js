import { randomUUID } from "node:crypto";
import { verifyTargetState } from '../verification/verifyTargetState.js';
import { validateDemoState } from './validateDemoState.js';
import { createPlatformAction, transitionPlatformAction } from "../domain/model/platformActionProtocol.js";

// Deliberately no filesystem, config loader, gateway, credential, scheduler,
// browser or network dependency. All prices are integer cents, synthetic only.
export function createOfflineStoreDemo({ store } = {}) {
  let state;
  let platformPrices;
  let revision = 0;
  let storageFailed = false;
  const snapshot = () => structuredClone(state);
  const move = (status, options = {}) => {
    state.action = transitionPlatformAction(state.action, status, options);
  };
  const reset = () => {
    state = {
      mode: "offline_demo", simulated: true, realPlatformVerified: false,
      sessionId: randomUUID(), storeId: "demo-store", storeName: "演示药房（合成数据）",
      products: [
        { id: "DEMO-001", name: "演示商品 A", price: 2000, target: 1800, cost: 1000, stock: 12 },
        { id: "DEMO-002", name: "演示商品 B", price: 1600, target: 1500, cost: null, stock: 8 },
        { id: "DEMO-003", name: "演示商品 C", price: 1200, target: null, cost: 700, stock: 0 }
      ],
      diagnosis: null, preview: null, action: null, review: null, executionScenario: null, readbackAttempts: [],
      submissionCount: 0, message: "离线演示：所有门店、商品与结果均为合成数据，不连接真实平台。"
    };
    platformPrices = new Map(state.products.map((item) => [item.id, item.price]));
    return snapshot();
  };
  reset();
  if (store) {
    const saved = store.read('pharmacy-session');
    if (saved) {
      const value = saved.value;
      if (value?.version !== 1 || value.state?.mode !== 'offline_demo' || value.state?.simulated !== true
        || value.state?.realPlatformVerified !== false || value.state?.storeId !== 'demo-store'
        || !Array.isArray(value.platformPrices) || value.platformPrices.length !== 3
        || value.platformPrices.some(row => !Array.isArray(row) || row.length !== 2
          || !['DEMO-001', 'DEMO-002', 'DEMO-003'].includes(row[0]) || !Number.isSafeInteger(row[1]) || row[1] < 0)
        || new Set(value.platformPrices.map(row => row[0])).size !== 3) {
        throw new Error('演示存档无效；保留原文件，不自动复位或执行。');
      }
      validateDemoState(value.state, state.products, new Map(value.platformPrices));
      state = structuredClone(value.state);
      platformPrices = new Map(value.platformPrices);
      revision = saved.revision;
    } else {
      revision = store.save('pharmacy-session', { version: 1, state, platformPrices: [...platformPrices] }, 0);
    }
  }
  const commands = {
    snapshot, reset,
    diagnose() {
      if (state.action) throw new Error("当前动作已有确认，请先完成回读或复位演示。");
      state.diagnosis = {
        simulated: true, checkedAt: new Date().toISOString(), coverage: "仅演示商品与模拟库存，不代表真实门店",
        missingCostCount: 1, stockoutCount: 1, repricingCandidateCount: 1,
        actualProfitImpact: null,
        priorities: [
          { id: "cost", title: "补充商品 B 成本", reason: "成本缺失，不能判断毛利或执行调价" },
          { id: "inventory", title: "核对商品 C 库存", reason: "模拟库存为零，补货前还需核对实际库存" },
          { id: "pricing", title: "审核商品 A 跟价建议", reason: "先预览价格与毛利，再确认模拟执行" }
        ]
      };
      return snapshot();
    },
    preview() {
      if (!state.diagnosis) throw new Error("请先运行诊断。");
      if (state.action) throw new Error("已确认的预览不可修改，请完成回读或复位演示。");
      const eligible = state.products.filter((item) => item.target !== null && item.cost !== null && (item.target - item.cost) / item.target >= 0.2);
      state.preview = {
        id: `${state.sessionId}:${randomUUID()}`, simulated: true, minimumMargin: 0.2,
        items: eligible.map((item) => ({ productId: item.id, name: item.name, before: item.price, after: item.target, cost: item.cost, margin: (item.target - item.cost) / item.target })),
        excluded: state.products.filter((item) => item.target !== null && !eligible.includes(item)).map((item) => ({ productId: item.id, reason: item.cost === null ? "missing_cost" : "margin_below_floor" }))
      };
      return structuredClone(state.preview);
    },
    confirm({ previewId, confirmed } = {}) {
      if (confirmed !== true) throw new Error("必须明确确认模拟预览。");
      if (!state.preview || state.preview.id !== previewId) throw new Error("预览已失效，请重新预览并确认。");
      if (state.action) throw new Error("该预览已经确认，不能重复确认。");
      state.action = createPlatformAction({
        platformId: "offline_demo", storeId: state.storeId, storeName: state.storeName,
        actionType: "update_prices", authorizationLevel: "B",
        authorizationEvidenceId: `demo-only:${previewId}`, idempotencyKey: previewId,
        immutableManifest: state.preview, metadata: { simulated: true, realPlatformVerified: false }
      });
      return snapshot();
    },
    execute({ scenario = "normal" } = {}) {
      if (!state.action) throw new Error("请先预览并确认模拟操作。");
      if (state.action.status !== "pending") throw new Error("本次已提交，禁止重复执行；请查看回读结果或复位演示。");
      if (!["normal", "response_lost", "mismatch", "readback_unavailable"].includes(scenario)) throw new Error("未知演示场景。");
      move("running");
      state.executionScenario = scenario;
      state.submissionCount += 1;
      for (const item of state.preview.items) platformPrices.set(item.productId, scenario === "mismatch" ? item.before : item.after);
      move("awaiting_readback", { reason: scenario === "response_lost" ? "模拟提交响应丢失，结果待核对，禁止重发。" : "模拟提交完成，但尚未回读，不能报成功。", mutationAttempted: true });
      state.message = state.action.reason;
      return snapshot();
    },
    readback() {
      if (state.action?.status !== "awaiting_readback") throw new Error("当前没有等待回读的模拟动作。");
      // A read attempt is not a write retry. Keep unavailable evidence distinct
      // from a mismatching target, and persist it before allowing another check.
      state.readbackAttempts ??= [];
      if (state.executionScenario === 'readback_unavailable' && state.readbackAttempts.length === 0) {
        state.readbackAttempts.push({ status: 'UNKNOWN', code: 'target_unavailable', simulated: true, realPlatformVerified: false });
        state.message = '结果未知（UNKNOWN）：本次模拟回读不可用，没有取得目标状态；禁止重复提交。可再次核对，演示将在下一次回读恢复。';
        return snapshot();
      }
      const scope = { planId: state.preview.id, connectorId: 'offline_demo', storeId: state.storeId };
      const verification = verifyTargetState({ ...scope,
        expected: state.preview.items.map(item => ({ targetId: item.productId, value: item.after })),
        readback: { ...scope, items: state.preview.items.map(item => ({ targetId: item.productId, value: platformPrices.get(item.productId) })) }
      });
      // Preserve the v1 checkpoint contract while sharing the actual comparator.
      // The mock always has a complete integer price map; unavailable reads are
      // handled above without creating a terminal result or resubmitting.
      const items = verification.items.map(item => ({ productId: item.targetId, expected: item.expected, observed: item.observed, matched: item.status === 'VERIFIED' }));
      const matched = verification.exact;
      const evidence = { exact: matched, simulated: true, realPlatformVerified: false, items };
      move(matched ? "readback_consistent" : "readback_inconsistent", { evidence });
      if (matched) move("succeeded", { evidence });
      state.review = { simulated: true, realPlatformVerified: false, items, matchedCount: items.filter((item) => item.matched).length, actualProfitImpact: null };
      state.readbackAttempts.push({ status: matched ? 'VERIFIED' : 'MISMATCH', code: matched ? 'exact_match' : 'target_mismatch', simulated: true, realPlatformVerified: false });
      state.message = matched ? "模拟回读一致；不代表真实平台执行成功，暂无实际利润效果。" : "模拟回读不一致：保留逐项差异，不能报成功或盲目重试。";
      return snapshot();
    }
  };
  if (!store) return commands;
  // Only safe for this wholly local mock: simulated target and task are saved
  // together. Real connectors need a pre-submit checkpoint and reconciliation.
  return Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, (...args) => {
    if (storageFailed) throw new Error('演示保存结果不明，请重新打开后核对；禁止继续执行。');
    const before = structuredClone(state);
    const pricesBefore = new Map(platformPrices);
    let result;
    try { result = command(...args); }
    catch (error) { state = before; platformPrices = pricesBefore; throw error; }
    if (name !== 'snapshot') {
      try {
        revision = store.save('pharmacy-session', { version: 1, state, platformPrices: [...platformPrices] }, revision);
      } catch (error) {
        state = before; platformPrices = pricesBefore; storageFailed = true;
        throw error;
      }
    }
    return result;
  }]));
}
