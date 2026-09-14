import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createTask } from '../task/taskState.js';
import { createTaskOwnership } from '../storage/taskOwnership.js';
import { createOfflineStoreDemo } from './offlineStoreDemo.js';
import { openAsyncPriceSession } from './asyncPriceSession.js';
import { projectAsyncPriceView } from './asyncPriceView.js';
import { runSupplemental, supplementalCatalog, validateSupplemental } from './supplementalOpportunities.js';

// Dedicated composition, not a migration of pharmacy-session. Caller supplies
// an isolated store namespace and keeps its connection open through whenIdle.
export function createAsyncStoreDemo({ store, executor = null }) {
  executor = structuredClone(executor);
  const products = createOfflineStoreDemo().snapshot().products;
  const key = 'async-demo-active';
  const shellTask = createTask({ id: 'async-demo-shell', namespace: 'offline_demo', connectorId: 'offline_demo', storeId: 'demo-store' });
  const shellOwner = createTaskOwnership({ store, scope: shellTask, executor });
  const read = () => {
    const row = store.read(key);
    if (!row || row.value?.version !== 1 || typeof row.value.sessionId !== 'string'
      || !row.value.sessionId.startsWith('demo-') || !row.value.supplemental
      || typeof row.value.supplemental !== 'object' || Array.isArray(row.value.supplemental))
      throw new Error('Invalid async Demo session; preserve records');
    for (const [kind, record] of Object.entries(row.value.supplemental)) validateSupplemental(record, row.value.sessionId, kind);
    return row;
  };
  const open = (id, create = false) => openAsyncPriceSession({ store, products, sessionId: id, create, executor });
  const save = (value, revision) => {
    const next = store.save(key, value, revision);
    const saved = read();
    if (saved.revision !== next || !isDeepStrictEqual(saved.value, value)) throw new Error('Demo session save uncertain');
  };
  if (!store.read(key)) {
    const token = shellOwner.acquire(shellTask);
    try {
      if (!store.read(key)) {
        const sessionId = `demo-${randomUUID()}`;
        open(sessionId, true);
        save({ version: 1, sessionId, supplemental: {} }, 0);
      }
    } finally { shellOwner.release(token); }
  }
  let sessionId = read().value.sessionId, price = open(sessionId), pending = null, localShellToken = null;
  const current = () => {
    const row = read();
    if (row.value.sessionId !== sessionId) throw new Error('Demo session changed; reopen before continuing');
    return row;
  };
  const snapshot = () => {
    const view = projectAsyncPriceView(price.snapshot());
    const shellToken = shellOwner.inspect()?.token;
    const priceToken = createTaskOwnership({ store, scope: view.task }).inspect()?.token;
    const foreignOwner = Boolean((shellToken && shellToken !== localShellToken) || (priceToken && !localShellToken));
    const interrupted = !localShellToken && ['EXECUTING', 'VERIFYING'].includes(view.task.status);
    const blocked = foreignOwner || interrupted;
    return { ...view, recovery: { required: blocked, canRecover: false,
      reason: foreignOwner ? 'EXECUTOR_UNCONFIRMED' : interrupted ? 'INTERRUPTED_TASK' : null,
      message: blocked ? '已有操作尚未完成核对，暂不能确认原执行已停止。请保留记录，不要重复执行、复位或手工解锁；当前版本尚无安全恢复入口。' : null },
      supplemental: structuredClone(current().value.supplemental), opportunityCatalog: supplementalCatalog() };
  };
  const commands = {
    async diagnose() {
      const task = price.snapshot().task;
      if (task.approval) throw new Error('请先完成当前任务或明确复位。');
      if (task.status !== 'AWAITING_APPROVAL') await price.check();
      return snapshot();
    },
    async preview() { await price.preview(); return snapshot().preview; },
    async confirm({ previewId, confirmed } = {}) { await price.confirm({ planId: previewId, confirmed }); return snapshot(); },
    async execute(input) { await price.execute(input); return snapshot(); },
    async readback() { await price.readback(); return snapshot(); },
    opportunity(input = {}) {
      if (!snapshot().diagnosis) throw new Error('请先运行诊断。');
      const row = current();
      const record = runSupplemental({ ...input, sessionId, record: row.value.supplemental[input.kind] });
      save({ ...row.value, supplemental: { ...row.value.supplemental, [input.kind]: record } }, row.revision);
      return snapshot();
    },
    reset({ confirmed } = {}) {
      if (confirmed !== true) throw new Error('必须明确确认复位演示。');
      const row = current(), task = price.snapshot().task;
      const owner = createTaskOwnership({ store, scope: task, executor });
      const token = owner.acquire(task);
      try {
        const nextId = `demo-${randomUUID()}`, nextPrice = open(nextId, true);
        save({ version: 1, sessionId: nextId, supplemental: {} }, row.revision);
        sessionId = nextId; price = nextPrice;
      } finally { owner.release(token); }
      return snapshot();
    }
  };
  return Object.freeze({ snapshot, whenIdle: () => pending ?? price.whenIdle(),
    ...Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, (...args) => {
      if (pending) return Promise.reject(new Error('演示操作仍在进行，请勿重复执行或复位。'));
      const token = shellOwner.acquire(shellTask);
      localShellToken = token;
      const operation = Promise.resolve().then(() => { current(); return command(...args); });
      const drain = async () => { await price.whenIdle(); shellOwner.release(token); localShellToken = null; };
      pending = operation.then(drain, drain);
      pending.then(() => { pending = null; }, () => { /* Keep fence on unconfirmed termination/release. */ });
      return operation;
    }]))
  });
}
