import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { createTaskOwnership } from '../src/storage/taskOwnership.js';
import { createTask } from '../src/task/taskState.js';
const scope = { id: 't', namespace: 'test', connectorId: 'mock', storeId: 'store' };
const task = createTask(scope);
function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'core-owner-')); const file = path.join(root, 'tasks.sqlite');
  const a = openStateStore(file, 'tasks'), b = openStateStore(file, 'tasks');
  try { run(a, b, file); } finally { a.close(); b.close(); rmSync(root, { recursive: true }); }
}
test('independent handles reject contention and stale release, new claims use fresh tokens', () => fixture((a, b) => {
  const first = createTaskOwnership({ store: a, scope }), second = createTaskOwnership({ store: b, scope });
  const token = first.acquire(task); second.assertHeld(token, task);
  assert.throws(() => second.acquire(task), /owned/);
  assert.throws(() => second.release('wrong'), /mismatch/);
  first.release(token); const next = second.acquire(task); assert.notEqual(next, token);
  assert.throws(() => first.release(token), /mismatch/); second.assertHeld(next, task);
  second.release(next);
}));
test('scope mismatch and corrupted ownership never overwrite existing claim', () => fixture((a) => {
  const owner = createTaskOwnership({ store: a, scope });
  assert.throws(() => owner.acquire({ ...task, storeId: 'other' }), /scope/);
  owner.acquire(task); const row = a.read('owner:t'); row.value.version = 99;
  a.save('owner:t', row.value, row.revision); const before = a.read('owner:t');
  assert.throws(() => owner.acquire(task), /Invalid/); assert.deepEqual(a.read('owner:t'), before);
}));
test('competing claim between read and save loses atomic revision race', () => fixture((a, b) => {
  const winner = createTaskOwnership({ store: b, scope }); let won;
  const loser = createTaskOwnership({ scope, store: { read: a.read, save(...args) {
    won = winner.acquire(task); return a.save(...args);
  } } });
  assert.throws(() => loser.acquire(task), /revision conflict/); winner.assertHeld(won, task);
  winner.release(won);
}));
test('real child process cannot acquire parent claim; exited child leaves explicit recovery requirement', () => fixture((a, _b, file) => {
  const owner = createTaskOwnership({ store: a, scope }); const token = owner.acquire(task);
  const source = `import {openStateStore} from ${JSON.stringify(pathToFileURL(path.resolve('src/storage/sqliteStateStore.js')).href)};
    import {createTaskOwnership} from ${JSON.stringify(pathToFileURL(path.resolve('src/storage/taskOwnership.js')).href)};
    const scope=${JSON.stringify(scope)}; const store=openStateStore(process.argv[1],'tasks');
    try { const owner=createTaskOwnership({store,scope});
      try { console.log(owner.acquire(scope)); } catch(e) { if(!e.message.includes('owned')) throw e; console.log('BLOCKED'); }
    } finally {store.close();}`;
  const child = () => spawnSync(process.execPath, ['--input-type=module', '-e', source, file], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const blocked = child(); assert.equal(blocked.status, 0, blocked.stderr); assert.equal(blocked.stdout.trim(), 'BLOCKED');
  owner.release(token); const exited = child(); assert.equal(exited.status, 0, exited.stderr);
  const abandoned = exited.stdout.trim(); owner.assertHeld(abandoned, task);
  assert.throws(() => owner.acquire(task), /owned/);
  assert.throws(() => owner.releaseAbandoned({ token: abandoned }), /termination/);
  assert.throws(() => owner.releaseAbandoned({ token, executorStopped: true }), /mismatch/);
  // spawnSync returned a confirmed exit code for the exact holder above.
  owner.releaseAbandoned({ token: abandoned, executorStopped: true });
  const fresh = owner.acquire(task); owner.release(fresh);
}));
