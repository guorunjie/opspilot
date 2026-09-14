import { createOfflineStoreDemo } from './offlineStoreDemo.js';
import { createAsyncStoreDemo } from './asyncStoreDemo.js';

// A v4 marker makes older Demo versions reject this database instead of
// silently creating an empty legacy session alongside the async records.
export function createDesktopDemo({ store, executor = null }) {
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
