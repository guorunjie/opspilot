import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createTask } from '../task/taskState.js';

// Non-expiring application lock. Never infer executor death from elapsed time.
export function createTaskOwnership({ store, scope }) {
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
      || row.value.version !== 1 || !isDeepStrictEqual(row.value.identity, identity)
      || !(row.value.token === null || (typeof row.value.token === 'string' && row.value.token.length > 0)))
      throw new Error('Invalid task ownership record');
    return row;
  };
  const assertScope = task => {
    if (!isDeepStrictEqual(createTask(task), identity)) throw new Error('Ownership task scope mismatch');
  };
  const save = (token, previous) => {
    const value = { kind: 'TaskOwnership', version: 1, identity, token };
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
    releaseAbandoned({ token, executorStopped } = {}) {
      if (executorStopped !== true) throw new Error('Confirmed executor termination required');
      release(token);
    }
  });
}
