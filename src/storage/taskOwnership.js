import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createTask } from '../task/taskState.js';

export const validExecutorIdentity = value => {
  const uuid = text => typeof text === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(text);
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'hostId,instanceId,pid'
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && uuid(value.instanceId) && uuid(value.hostId));
};
// Non-expiring application lock. Never infer executor death from elapsed time.
export function createTaskOwnership({ store, scope, executor = null }) {
  const validExecutor = validExecutorIdentity;
  if (executor !== null && !validExecutor(executor)) throw new TypeError('Valid executor identity required');
  const executorIdentity = structuredClone(executor);
  const identity = createTask(scope);
  const key = `owner:${identity.id}`;
  if (key.length > 256 || typeof store?.read !== 'function' || typeof store?.save !== 'function')
    throw new TypeError('Valid scoped ownership store required');
  const sync = value => {
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {}); throw new Error('Ownership requires synchronous atomic storage');
    }
    return value;
  };
  const read = () => {
    const row = sync(store.read(key));
    if (!row) return null;
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.value?.kind !== 'TaskOwnership'
      || ![1, 2].includes(row.value.version) || !isDeepStrictEqual(row.value.identity, identity)
      || !(row.value.token === null || (typeof row.value.token === 'string' && row.value.token.length > 0)))
      throw new Error('Invalid task ownership record');
    if (row.value.version === 2 && (row.value.token === null ? row.value.executor !== null : !validExecutor(row.value.executor)))
      throw new Error('Invalid ownership executor identity');
    return row;
  };
  const assertScope = task => {
    if (!isDeepStrictEqual(createTask(task), identity)) throw new Error('Ownership task scope mismatch');
  };
  const save = (token, previous) => {
    const version = token ? (executorIdentity ? 2 : 1) : (previous?.value.version ?? 1);
    const value = { kind: 'TaskOwnership', version, identity, token,
      ...(version === 2 ? { executor: token ? executorIdentity : null } : {}) };
    const revision = sync(store.save(key, structuredClone(value), previous?.revision ?? 0));
    const saved = read();
    if (revision !== (previous?.revision ?? 0) + 1 || saved?.revision !== revision
      || !isDeepStrictEqual(saved.value, value)) throw new Error('Ownership acknowledgement uncertain');
  };
  const release = token => {
    const row = read();
    if (!token || row?.value.token !== token) throw new Error('Ownership token mismatch');
    save(null, row);
  };
  return Object.freeze({
    inspect: () => structuredClone(read()?.value ?? null),
    acquire(task) {
      assertScope(task);
      const previous = read();
      if (previous?.value.token) throw new Error('Task owned by another operation');
      const token = randomUUID(); save(token, previous); return token;
    },
    assertHeld(token, task) {
      assertScope(task);
      if (!token || read()?.value.token !== token) throw new Error('Task ownership lost');
    },
    release,
    takeOverAbandoned({ expected, confirmStopped } = {}) {
      if (!executorIdentity || !expected?.token || expected.version !== 2 || typeof confirmStopped !== 'function')
        throw new Error('Bound abandoned ownership required');
      const row = read();
      if (!isDeepStrictEqual(row?.value, expected)) throw new Error('Ownership changed before recovery');
      if (sync(confirmStopped(structuredClone(row.value.executor))) !== true)
        throw new Error('Confirmed executor termination required');
      // Replace the exact claim in one CAS. Never expose an unlocked gap.
      const token = randomUUID(); save(token, row); return token;
    },
    releaseAbandoned({ token, executorStopped } = {}) {
      if (executorStopped !== true) throw new Error('Confirmed executor termination required');
      release(token);
    }
  });
}
