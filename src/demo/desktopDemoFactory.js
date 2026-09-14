import { createOfflineStoreDemo } from './offlineStoreDemo.js';
import { createAsyncStoreDemo } from './asyncStoreDemo.js';
import { isDeepStrictEqual } from 'node:util';

// A v4 marker makes older Demo versions reject this database instead of
// silently creating an empty legacy session alongside the async records.
function openDemo({ store, executor = null }) {
  const legacy = store.read('pharmacy-session');
  const active = store.read('async-demo-active');
  if (legacy?.value?.version === 4) {
    if (legacy.value.engine !== 'async-demo') throw new Error('Unknown Demo engine; preserve records');
    return createAsyncStoreDemo({ store, executor });
  }
  if (legacy) {
    if (active) throw new Error('Conflicting Demo formats; preserve both records');
    return createOfflineStoreDemo({ store });
  }
  if (active) throw new Error('Async Demo format marker missing; preserve records');
  const marker = { version: 4, engine: 'async-demo' };
  const revision = store.save('pharmacy-session', marker, 0);
  const saved = store.read('pharmacy-session');
  if (revision !== 1 || saved?.revision !== 1 || saved.value.version !== 4 || saved.value.engine !== 'async-demo')
    throw new Error('Demo format marker acknowledgement uncertain');
  return createAsyncStoreDemo({ store, executor });
}

// The original legacy row is embedded in the marker in ONE conditional write.
// A crash cannot publish a new engine without its archive. Async initialization
// may finish on reopen; no old plan, approval or target enters the new session.
export function createDesktopDemo({ store, executor = null }) {
  const readArchive = marker => {
    if (!Object.hasOwn(marker, 'legacyArchive')) return null;
    const row = marker.legacyArchive;
    if (!Number.isSafeInteger(row?.revision) || row.revision < 1 || ![1, 2, 3].includes(row.value?.version))
      throw new Error('Invalid legacy archive; preserve records');
    return createOfflineStoreDemo({ store: { read: key => {
      if (key !== 'pharmacy-session') throw new Error('Unexpected archive key');
      return structuredClone(row);
    }, save: () => { throw new Error('Archive is read-only'); } } }).snapshot();
  };
  const initial = store.read('pharmacy-session');
  let archive = initial?.value?.version === 4 ? readArchive(initial.value) : null;
  let demo = openDemo({ store, executor });
  let poisoned = false;
  const ensure = () => { if (poisoned) throw new Error('升级保存结果不明，请重新打开核对；禁止继续操作。'); };
  const decorate = result => {
    if (result?.mode !== 'offline_demo') return result;
    const marker = store.read('pharmacy-session');
    const legacy = [1, 2, 3].includes(marker?.value?.version);
    return { ...result, legacyUpgrade: legacy ? { available: true, revision: marker.revision } : null,
      legacyArchive: archive ? structuredClone(archive) : null };
  };
  const api = {};
  for (const name of ['snapshot', 'diagnose', 'preview', 'confirm', 'execute', 'readback', 'reset', 'opportunity', 'recover']) {
    api[name] = (...args) => {
      ensure();
      if (typeof demo[name] !== 'function') throw new Error('当前演示不支持此操作。');
      const result = demo[name](...args);
      return result?.then ? result.then(decorate) : decorate(result);
    };
  }
  api.whenIdle = () => demo.whenIdle?.();
  api.upgrade = ({ confirmed, expectedRevision } = {}) => {
    ensure();
    if (confirmed !== true) throw new Error('必须明确确认保留旧记录并开始新版演示。');
    const old = store.read('pharmacy-session');
    if (!old || ![1, 2, 3].includes(old.value?.version) || old.revision !== expectedRevision || store.read('async-demo-active'))
      throw new Error('演示记录已变化，请重新打开核对。');
    // Validate saved content before switching. No archive commands are exposed.
    const marker = { version: 4, engine: 'async-demo', legacyArchive: structuredClone(old) };
    const savedArchive = readArchive(marker);
    try {
      const revision = store.save('pharmacy-session', marker, old.revision);
      if (revision !== old.revision + 1 || !isDeepStrictEqual(store.read('pharmacy-session'), { revision, value: marker }))
        throw new Error('Demo upgrade acknowledgement uncertain');
      archive = savedArchive;
      demo = openDemo({ store, executor });
      return api.snapshot();
    } catch (error) { poisoned = true; throw error; }
  };
  return api;
}
