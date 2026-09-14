import { isDeepStrictEqual } from 'node:util';
import { advanceTask, assertTask } from '../task/taskState.js';

// Trusted application composition; persistence remains synchronous/atomic.
// Supports asynchronous planner and simulated gateway, not production writes.
export function createAsyncTaskAgent({ getTask, checkpoint, planner, memory = { read: () => null },
  gateway, writeCapabilityId, readCapabilityId, timeoutMs = 30000 }) {
  for (const hook of [getTask, checkpoint, gateway?.get]) {
    if (typeof hook !== 'function' || hook.constructor?.name === 'AsyncFunction')
      throw new TypeError('Persistence and capability metadata must be synchronous');
  }
  for (const hook of [planner?.proposePlan, memory?.read, gateway?.invoke])
    if (typeof hook !== 'function') throw new TypeError('Application hooks required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new TypeError('Timeout must be 1..600000 milliseconds');
  const sync = value => {
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      throw new TypeError('Asynchronous persistence is unsupported');
    }
    return value;
  };
  let busy = false, outstanding = false, poisoned = false;
  const current = () => structuredClone(assertTask(sync(getTask())));
  const commit = (event, previous = current()) => {
    const next = advanceTask(previous, event);
    try {
      if (!isDeepStrictEqual(current(), previous)) throw new Error('Task changed during asynchronous operation');
      sync(checkpoint(structuredClone(next), structuredClone(previous)));
      if (!isDeepStrictEqual(current(), next)) throw new Error('Checkpoint was not acknowledged');
    } catch (error) { poisoned = true; throw error; }
    return next;
  };
  // Timeout requests cooperative abort but retains the in-flight fence until
  // the original promise settles. A late response never installs a task event.
  const bounded = async work => {
    const controller = new AbortController();
    let timer;
    outstanding = true;
    const running = Promise.resolve().then(() => work(controller.signal));
    const settled = running.then(value => { outstanding = false; return value; }, error => {
      outstanding = false; throw error;
    });
    try {
      return await Promise.race([settled, new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Operation timed out; outcome is unknown'));
          controller.abort();
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const role = (id, expected) => {
    if (sync(gateway.get(id))?.riskLevel !== expected) throw new Error('Capability role mismatch');
  };
  const request = task => ({ planId: task.plan.id, storeId: task.storeId,
    items: structuredClone(task.plan.items), idempotencyKey: task.run.idempotencyKey });
  const commands = {
    check: ready => commit({ type: 'CHECK', ready }),
    async propose({ input, planId }) {
      const previous = current(); const safeInput = structuredClone(input);
      if (!['READY', 'AWAITING_APPROVAL'].includes(previous.status) || previous.approval)
        throw new Error('Planning requires a checked unapproved task');
      const proposal = structuredClone(await bounded(async signal => {
        const recalled = await memory.read({ taskId: previous.id, namespace: previous.namespace }, { signal });
        signal.throwIfAborted();
        return planner.proposePlan(safeInput, { task: structuredClone(previous), memory: structuredClone(recalled), signal });
      }));
      return { proposal, task: commit({ type: 'PLAN', plan: { id: planId, items: proposal?.items } }, previous) };
    },
    approve: ({ planId, confirmed }) => commit({ type: 'APPROVE', planId, confirmed }),
    async execute({ runId }) {
      role(writeCapabilityId, 'simulated_write');
      const started = commit({ type: 'START', runId });
      let result;
      try { result = structuredClone(await bounded(signal => {
        if (!isDeepStrictEqual(current(), started)) throw new Error('Task changed before invocation');
        return gateway.invoke(writeCapabilityId, request(started), { signal });
      })); }
      catch (error) { commit({ type: 'INTERRUPT' }, started); throw error; }
      return { result, task: commit({ type: 'SUBMIT', uncertain: result?.status !== 'SUBMITTED' }, started) };
    },
    async verify() {
      role(readCapabilityId, 'readonly');
      const started = commit({ type: 'BEGIN_VERIFY' });
      let readback;
      try { readback = structuredClone(await bounded(signal => {
        if (!isDeepStrictEqual(current(), started)) throw new Error('Task changed before invocation');
        return gateway.invoke(readCapabilityId, request(started), { signal });
      })); }
      catch (error) { commit({ type: 'INTERRUPT' }, started); throw error; }
      const task = commit({ type: 'READBACK', readback }, started);
      return { readback, task, verification: structuredClone(task.verifications.at(-1)) };
    },
    recover({ previousExecutorStopped } = {}) {
      if (previousExecutorStopped !== true) throw new Error('Recovery requires confirmed previous executor termination');
      const task = current();
      return ['EXECUTING', 'VERIFYING'].includes(task.status) ? commit({ type: 'INTERRUPT' }, task) : task;
    }
  };
  return Object.freeze({
    snapshot: current,
    ...Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, async (...args) => {
      if (poisoned) throw new Error('Checkpoint uncertain; reopen and reconcile');
      if (busy || outstanding) throw new Error('An operation is still in progress');
      busy = true;
      try { return await command(...args); } finally { busy = false; }
    }]))
  });
}
