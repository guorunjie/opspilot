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
import { randomUUID } from 'node:crypto';
const scope = { id: 't', namespace: 'test', connectorId: 'mock', storeId: 'store' };
const task = createTask(scope);
test('executor identity is atomically bound to a claim and never retrofitted onto legacy claims', () => fixture((a, b) => {
  const executor = { pid: process.pid, instanceId: randomUUID(), hostId: randomUUID() };
  const original = structuredClone(executor);
  const writer = createTaskOwnership({ store: a, scope, executor });
  executor.pid = 1;
  const token = writer.acquire(task);
  const reader = createTaskOwnership({ store: b, scope });
  assert.equal(reader.inspect().version, 2);
  assert.deepEqual(reader.inspect().executor, original);
  const detached = reader.inspect(); detached.executor.pid = 2;
  assert.deepEqual(reader.inspect().executor, original);
  assert.throws(() => reader.acquire(task), /owned/);
  reader.release(token);
  assert.equal(reader.inspect().executor, null);
  const legacyToken = reader.acquire(task);
  assert.equal(writer.inspect().version, 1);
  assert.equal(writer.inspect().executor, undefined);
  assert.throws(() => writer.acquire(task), /owned/);
  reader.release(legacyToken);
}));

test('invalid executor metadata is rejected without changing a claim', () => fixture(a => {
  for (const executor of [{ pid: 0, instanceId: randomUUID() }, { pid: process.pid, instanceId: 'invalid' }])
    assert.throws(() => createTaskOwnership({ store: a, scope, executor }), /executor/);
  const owner = createTaskOwnership({ store: a, scope, executor: { pid: process.pid, instanceId: randomUUID(), hostId: randomUUID() } });
  owner.acquire(task);
  const row = a.read('owner:t'); row.value.executor.pid = -1;
  a.save('owner:t', row.value, row.revision);
  const before = a.read('owner:t');
  assert.throws(() => owner.inspect(), /executor/);
  assert.throws(() => owner.acquire(task), /executor/);
  assert.deepEqual(a.read('owner:t'), before);
}));
test('abandoned takeover requires a fresh exact claim and synchronous proof, and never unlocks', () => fixture((a, b) => {
  const executor = { pid: process.pid, instanceId: randomUUID(), hostId: randomUUID() };
  const owner = createTaskOwnership({ store: a, scope, executor });
  const competitor = createTaskOwnership({ store: b, scope, executor });
  const token = owner.acquire(task), expected = owner.inspect();
  assert.throws(() => competitor.takeOverAbandoned({ expected, confirmStopped: async () => true }), /synchronous/);
  assert.throws(() => competitor.takeOverAbandoned({ expected, confirmStopped: () => false }), /termination/);
  assert.equal(owner.inspect().token, token);
  const next = competitor.takeOverAbandoned({ expected, confirmStopped: () => {
    assert.throws(() => owner.acquire(task), /owned/); return true;
  } });
  assert.notEqual(next, token);
  assert.throws(() => owner.release(token), /mismatch/);
  assert.throws(() => owner.takeOverAbandoned({ expected, confirmStopped: () => assert.fail('stale proof') }), /changed/);
  assert.throws(() => owner.acquire(task), /owned/);
  competitor.release(next);
  const changedToken = owner.acquire(task), stale = owner.inspect();
  let replacement;
  assert.throws(() => competitor.takeOverAbandoned({ expected: stale, confirmStopped: () => {
    owner.release(changedToken); replacement = owner.acquire(task); return true;
  } }), /revision conflict/);
  assert.equal(owner.inspect().token, replacement);
  owner.release(replacement);
}));

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
