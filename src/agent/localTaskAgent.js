import { isDeepStrictEqual } from 'node:util';
import { advanceTask, assertTask } from '../task/taskState.js';

// Application-owned composition, not a model-driven tool loop or plugin sandbox.
// Hooks are synchronous: durable external/browser execution needs an async runtime.
export function createLocalTaskAgent({ getTask, checkpoint, planner, memory = { read: () => null },
  gateway, writeCapabilityId, readCapabilityId }) {
  for (const hook of [getTask, checkpoint, planner?.proposePlan, memory?.read, gateway?.get, gateway?.invoke]) {
    if (typeof hook !== 'function' || hook.constructor?.name === 'AsyncFunction')
      throw new TypeError('Local agent requires synchronous application-owned hooks');
  }
  let busy = false, poisoned = false;
  const sync = value => {
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      throw new Error('Asynchronous hooks require an async runtime');
    }
    return value;
  };
  const current = () => structuredClone(assertTask(sync(getTask())));
  const commit = event => {
    const previous = current();
    const next = advanceTask(previous, event);
    try {
      sync(checkpoint(structuredClone(next), structuredClone(previous)));
      if (!isDeepStrictEqual(current(), next)) throw new Error('Checkpoint was not acknowledged');
    } catch (error) { poisoned = true; throw error; }
    return next;
  };
  const request = () => {
    const task = current();
    return { planId: task.plan.id, storeId: task.storeId, items: structuredClone(task.plan.items) };
  };
  const requireCapability = (id, risk) => {
    if (sync(gateway.get(id))?.riskLevel !== risk) throw new Error('Agent capability risk does not match its role');
  };
  const commands = {
    snapshot: current,
    check: ready => commit({ type: 'CHECK', ready }),
    propose({ input, planId }) {
      const task = current();
      if (!['READY', 'AWAITING_APPROVAL'].includes(task.status) || task.approval)
        throw new Error('Agent planning requires a checked, unapproved task');
      const recalled = sync(memory.read({ taskId: task.id, namespace: task.namespace }));
      const proposal = structuredClone(sync(planner.proposePlan(structuredClone(input), {
        task: structuredClone(task), memory: structuredClone(recalled)
      })));
      // Ignore any model-supplied approval, run, status, capability or plan ID.
      const next = commit({ type: 'PLAN', plan: { id: planId, items: proposal?.items } });
      return { proposal, task: next };
    },
    approve: ({ planId, confirmed }) => commit({ type: 'APPROVE', planId, confirmed }),
    execute({ runId, uncertain = false }) {
      if (typeof uncertain !== 'boolean') throw new TypeError('Submission certainty must be explicit');
      requireCapability(writeCapabilityId, 'simulated_write');
      commit({ type: 'START', runId }); // Always before crossing the gateway.
      let result;
      try { result = structuredClone(sync(gateway.invoke(writeCapabilityId, request()))); }
      catch (error) { commit({ type: 'INTERRUPT' }); throw error; }
      // Neither a model's "done" nor a gateway's "verified" is target evidence.
      const task = commit({ type: 'SUBMIT', uncertain: uncertain || result?.status !== 'SUBMITTED' });
      return { result, task };
    },
    verify() {
      requireCapability(readCapabilityId, 'readonly');
      commit({ type: 'BEGIN_VERIFY' });
      let readback;
      try { readback = structuredClone(sync(gateway.invoke(readCapabilityId, request()))); }
      catch (error) { commit({ type: 'INTERRUPT' }); throw error; }
      const task = commit({ type: 'READBACK', readback });
      return { readback, task, verification: structuredClone(task.verifications.at(-1)) };
    },
    recover() {
      const task = current();
      return ['EXECUTING', 'VERIFYING'].includes(task.status) ? commit({ type: 'INTERRUPT' }) : task;
    }
  };
  return Object.freeze(Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, (...args) => {
    if (poisoned) throw new Error('Agent checkpoint uncertain; reopen and reconcile before continuing');
    if (busy) throw new Error('Agent operation already in progress');
    busy = true;
    try { return command(...args); } finally { busy = false; }
  }])));
}
