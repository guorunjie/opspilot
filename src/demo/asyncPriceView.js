import { isDeepStrictEqual } from 'node:util';
import { assertTask } from '../task/taskState.js';
import { diagnoseProducts, planPrices } from '../domain/model/pricePlanning.js';

// Read-only projection. Never emits Task events, authorization or target writes.
export function projectAsyncPriceView({ task, platform, details }) {
  assertTask(task);
  if (platform?.identity?.simulated !== true || platform.identity.sessionId !== task.id
    || task.namespace !== 'offline_demo' || task.connectorId !== 'offline_demo' || task.storeId !== 'demo-store')
    throw new Error('Async Demo view scope mismatch');
  const products = platform.identity.products;
  const expected = planPrices(products, { minimumMargin: 0.2 });
  if (!isDeepStrictEqual(details, expected) || (task.plan && !isDeepStrictEqual(task.plan.items,
    expected.items.map(item => ({ targetId: item.productId, before: item.before, value: item.after })))))
    throw new Error('Async Demo view plan mismatch');
  const latest = task.verifications.at(-1);
  const hasReview = latest && ['VERIFIED', 'FAILED', 'PARTIALLY_VERIFIED'].includes(task.status);
  const items = hasReview ? latest.items.map(item => ({ productId: item.targetId,
    expected: item.expected, observed: item.observed, matched: item.status === 'VERIFIED' })) : [];
  const labels = { NOT_CHECKED: '尚未诊断，不能判断门店状态。', READY: '诊断已完成，请查看建议依据和预览。',
    AWAITING_APPROVAL: task.approval ? '已保存本次模拟确认，尚未执行。' : '请核对本次预览，再明确确认。',
    EXECUTING: '正在执行模拟操作；不要重复提交或复位。', SUBMITTED: '模拟操作已提交，尚未回读，不能报告成功。',
    VERIFYING: '正在独立回读模拟目标。', UNKNOWN: '结果未知（UNKNOWN），请核对已有任务，不要重复执行。',
    VERIFIED: '模拟回读一致；不代表真实平台执行成功，实际利润效果未知。',
    FAILED: '模拟回读不一致，保留差异；不能报告成功。', PARTIALLY_VERIFIED: '仅部分目标回读一致，不能报告整体成功。' };
  return structuredClone({
    mode: 'offline_demo', simulated: true, realPlatformVerified: false,
    sessionId: task.id, storeId: task.storeId, storeName: '演示药房（合成数据）', products, task,
    diagnosis: task.status === 'NOT_CHECKED' ? null : { ruleVersion: 1, simulated: true,
      coverage: '仅演示商品与模拟库存，不代表真实门店', ...diagnoseProducts(products), actualProfitImpact: null },
    preview: task.plan ? { id: task.plan.id, simulated: true, minimumMargin: 0.2, ...details } : null,
    // UI-only compatibility marker; not an executable PlatformAction or consent.
    action: task.approval ? { status: task.run ? 'awaiting_readback' : 'pending', statusLabel: labels[task.status] } : null,
    executionScenario: platform.scenario, submissionCount: platform.submissionCount,
    readbackAttempts: task.verifications.map(result => ({ status: result.status, simulated: true, realPlatformVerified: false })),
    review: hasReview ? { simulated: true, realPlatformVerified: false, items,
      matchedCount: items.filter(item => item.matched).length, actualProfitImpact: null } : null,
    message: labels[task.status] ?? `任务状态：${task.status}；请人工核对。`,
    opportunityCatalog: {} // Supplemental composition is owned by the desktop adapter.
  });
}
