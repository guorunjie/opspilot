import { isDeepStrictEqual } from 'node:util';
import { createTask, assertTask, advanceTask } from '../task/taskState.js';

// Application-owned store with atomic save(key, value, expectedRevision).
// Owns no connection and performs no execution, automatic recovery or deletion.
export function openPersistentTask({ store, scope, create = false }) {
  if (typeof create !== 'boolean' || typeof store?.read !== 'function' || typeof store?.save !== 'function')
    throw new TypeError('Explicit synchronous state store required');
  const initial = createTask(scope);
  const key = `task:${initial.id}`;
  if (key.length > 256) throw new TypeError('Task storage key is too long');
  const sync = value => {
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      throw new TypeError('Task persistence requires a synchronous atomic store');
    }
    return value;
  };
  const read = () => {
    const record = sync(store.read(key));
    if (!record) return null;
    if (!Number.isSafeInteger(record.revision) || record.revision < 1
      || record.value?.version !== 1 || record.value?.kind !== 'PersistentTask')
      throw new Error('Invalid persistent task envelope');
    const task = structuredClone(assertTask(record.value.task));
    if (!isDeepStrictEqual(createTask(task), initial)) throw new Error('Persistent task scope mismatch');
    return { revision: record.revision, task };
  };
  if (!read()) {
    if (!create) throw new Error('Task does not exist; explicit creation required');
    sync(store.save(key, { kind: 'PersistentTask', version: 1, task: initial }, 0));
  }
  if (!read()) throw new Error('Task creation was not acknowledged');
  let poisoned = false;
  const current = () => {
    if (poisoned) throw new Error('Task checkpoint uncertain; reopen before continuing');
    const record = read();
    if (!record) throw new Error('Persistent task disappeared');
    return record;
  };
  return Object.freeze({
    getTask: () => current().task,
    checkpoint(next, previous) {
      const record = current();
      assertTask(previous); assertTask(next);
      if (!isDeepStrictEqual(record.task, previous)) throw new Error('Stale task checkpoint');
      if (next.history.length !== previous.history.length + 1
        || !isDeepStrictEqual(advanceTask(previous, next.history.at(-1)), next))
        throw new Error('Checkpoint must append exactly one valid task event');
      try {
        const revision = sync(store.save(key, { kind: 'PersistentTask', version: 1,
          task: structuredClone(next) }, record.revision));
        const saved = read();
        if (revision !== record.revision + 1 || saved?.revision !== revision
          || !isDeepStrictEqual(saved.task, next)) throw new Error('Task checkpoint was not acknowledged');
      } catch (error) { poisoned = true; throw error; }
    }
  });
}
