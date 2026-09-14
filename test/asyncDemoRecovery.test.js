import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { createAsyncStoreDemo } from '../src/demo/asyncStoreDemo.js';

const url = file => JSON.stringify(pathToFileURL(path.resolve(file)).href);
const child = (file, hostId, point, recovery = false) => {
  const source = `
    import {openStateStore} from ${url('src/storage/sqliteStateStore.js')};
    import {createAsyncStoreDemo} from ${url('src/demo/asyncStoreDemo.js')};
    import {randomUUID} from 'node:crypto';
    const executor={hostId:process.argv[2],pid:process.pid,instanceId:randomUUID()};
    const raw=openStateStore(process.argv[1],'recovery');
    const store={read:raw.read,save(key,value,revision){
      const result=raw.save(key,value,revision);
      const point=${JSON.stringify(point)};
      if (point==='started' && key.startsWith('task:') && value.task?.status==='EXECUTING') process.exit(23);
      if (point==='reserved' && key.startsWith('async-price:') && value.scenario!==null && value.submissionCount===0) process.exit(23);
      if (point==='written' && key.startsWith('async-price:') && value.submissionCount===1) process.exit(23);
      if (point==='verify-started' && key.startsWith('task:') && value.task?.status==='VERIFYING') process.exit(23);
      if (point==='verify-saved' && key.startsWith('task:') && value.task?.status==='VERIFIED') process.exit(23);
      if (point==='shell-taken' && key==='owner:async-demo-shell' && value.token && value.executor?.pid===process.pid) process.exit(23);
      if (point==='price-taken' && key.startsWith('owner:demo-') && value.token && value.executor?.pid===process.pid) process.exit(23);
      if (point==='interrupted' && key.startsWith('task:') && value.task?.status==='UNKNOWN') process.exit(23);
      return result;
    }};
    const demo=createAsyncStoreDemo({store,executor});
    if (${recovery}) demo.recover({confirmed:true});
    else {
      const call=async(method,input)=>{await demo[method](input);await demo.whenIdle();};
      await call('diagnose');const plan=await demo.preview();await demo.whenIdle();
      await call('confirm',{previewId:plan.id,confirmed:true});await call('execute');
      if (${JSON.stringify(point)}.startsWith('verify-')) await call('readback');
    }
    process.exit(99);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, file, hostId],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 23, result.stderr);
};
const fixture = async run => {
  const root = mkdtempSync(path.join(tmpdir(), 'core-recover-'));
  const file = path.join(root, 'demo.sqlite'), hostId = randomUUID();
  let store;
  try { await run({ file, hostId, open() {
    store = openStateStore(file, 'recovery');
    const executor = { hostId, pid: process.pid, instanceId: randomUUID() };
    return { store, executor, demo: createAsyncStoreDemo({ store, executor }) };
  } }); } finally { store?.close(); rmSync(root, { recursive: true }); }
};
for (const point of ['started', 'reserved', 'written', 'verify-started']) {
  test(`confirmed local recovery after ${point} never resubmits and requires independent readback`, () => fixture(async ({ file, hostId, open }) => {
    child(file, hostId, point);
    const { demo } = open();
    const before = demo.snapshot();
    assert.equal(before.task.status, point === 'verify-started' ? 'VERIFYING' : 'EXECUTING');
    assert.equal(before.recovery.canRecover, true);
    assert.throws(() => demo.recover({ previousExecutorStopped: true }), /明确确认/);
    assert.deepEqual(demo.snapshot(), before);
    const recovered = demo.recover({ confirmed: true });
    assert.equal(recovered.task.status, 'UNKNOWN'); assert.equal(recovered.review, null);
    assert.equal(recovered.recovery.required, false);
    assert.equal(recovered.submissionCount, before.submissionCount);
    await assert.rejects(demo.execute(), /Approved unexecuted/); await demo.whenIdle();
    await demo.readback(); await demo.whenIdle();
    assert.equal(demo.snapshot().task.status, ['written', 'verify-started'].includes(point) ? 'VERIFIED' : 'FAILED');
    assert.equal(demo.snapshot().submissionCount, before.submissionCount);
  }));
}
test('recovery after a saved verification preserves its evidence and terminal result', () => fixture(async ({ file, hostId, open }) => {
  child(file, hostId, 'verify-saved');
  const { demo } = open();
  const before = demo.snapshot();
  assert.equal(before.task.status, 'VERIFIED');
  assert.equal(before.recovery.canRecover, true);
  const recovered = demo.recover({ confirmed: true });
  assert.equal(recovered.recovery.required, false);
  assert.deepEqual(recovered.task, before.task);
  assert.deepEqual(recovered.review, before.review);
  assert.equal(recovered.submissionCount, 1);
  await assert.rejects(demo.execute(), /Approved unexecuted/); await demo.whenIdle();
  assert.deepEqual(demo.snapshot().task, before.task);
}));
for (const point of ['shell-taken', 'price-taken', 'interrupted']) {
  test(`a second crash during recovery at ${point} can reconcile without an unlocked write gap`, () => fixture(async ({ file, hostId, open }) => {
    child(file, hostId, 'written'); child(file, hostId, point, true);
    const { demo } = open();
    assert.equal(demo.snapshot().recovery.canRecover, true);
    demo.recover({ confirmed: true });
    assert.equal(demo.snapshot().task.status, 'UNKNOWN');
    await demo.readback(); await demo.whenIdle();
    assert.equal(demo.snapshot().task.status, 'VERIFIED');
    assert.equal(demo.snapshot().submissionCount, 1);
  }));
}
test('live, foreign and legacy ownership cannot be recovered even with a confirmation', () => fixture(async ({ file, hostId, open }) => {
  child(file, hostId, 'written');
  const { demo, store } = open();
  const key = 'owner:async-demo-shell';
  const original = store.read(key).value;
  for (const value of [
    { ...original, executor: { ...original.executor, pid: process.pid } },
    { ...original, executor: { ...original.executor, hostId: randomUUID() } },
    { kind: original.kind, version: 1, identity: original.identity, token: original.token }
  ]) {
    store.save(key, value, store.read(key).revision);
    const before = store.read(key);
    assert.equal(demo.snapshot().recovery.canRecover, false);
    assert.throws(() => demo.recover({ confirmed: true }), /无法确认/);
    assert.deepEqual(store.read(key), before);
  }
}));

test('uncertain recovery checkpoint preserves both claims and blocks further mutation', () => fixture(async ({ file, hostId, open }) => {
  child(file, hostId, 'written');
  const { store, executor } = open();
  const wrapped = { read: store.read, save(key, value, revision) {
    const saved = store.save(key, value, revision);
    if (key.startsWith('task:') && value.task?.status === 'UNKNOWN') throw new Error('Recovery acknowledgement lost');
    return saved;
  } };
  const demo = createAsyncStoreDemo({ store: wrapped, executor });
  assert.throws(() => demo.recover({ confirmed: true }), /acknowledgement lost/);
  assert.throws(() => demo.snapshot(), /checkpoint uncertain/);
  // The poisoned handle cannot invent an acknowledged state. Reopen only to
  // inspect storage; the still-live recovery executor must continue to block.
  const after = createAsyncStoreDemo({ store, executor }).snapshot();
  assert.equal(after.task.status, 'UNKNOWN'); assert.equal(after.submissionCount, 1);
  assert.equal(after.recovery.required, true); assert.equal(after.recovery.canRecover, false);
  for (const key of ['owner:async-demo-shell', `owner:${after.sessionId}`]) {
    assert.ok(store.read(key).value.token);
    assert.equal(store.read(key).value.executor.pid, process.pid);
  }
  assert.throws(() => demo.readback(), /owned/);
  assert.throws(() => demo.execute(), /owned/);
}));
