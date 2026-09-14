import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectExecutorPresence } from '../src/storage/executorPresence.js';
const hostId = randomUUID();
const identity = pid => ({ pid, instanceId: randomUUID(), hostId });
test('presence probe never queries a foreign or unbound host and only sends signal zero', () => {
  for (const executor of [null, { pid: process.pid }, identity(0), { ...identity(process.pid), hostId: randomUUID() }])
    assert.equal(inspectExecutorPresence(executor, hostId, () => assert.fail('must not query')).status, 'UNKNOWN');
  assert.equal(inspectExecutorPresence(identity(process.pid), hostId, (pid, signal) => {
    assert.equal(pid, process.pid); assert.equal(signal, 0); return true;
  }).status, 'PRESENT');
});
test('permission errors, unexpected results and asynchronous probes remain unknown', () => {
  for (const probe of [() => false, () => undefined, async () => true,
    () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }])
    assert.equal(inspectExecutorPresence(identity(process.pid), hostId, probe).status, 'UNKNOWN');
  assert.equal(inspectExecutorPresence(identity(process.pid), hostId, () => {
    throw Object.assign(new Error('missing'), { code: 'ESRCH' });
  }).status, 'ABSENT');
});
test('real current process is present and confirmed exited child is absent or conservatively reused', () => {
  assert.equal(inspectExecutorPresence(identity(process.pid), hostId).status, 'PRESENT');
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0); assert.equal(child.error, undefined);
  const result = inspectExecutorPresence(identity(child.pid), hostId);
  // PID reuse only blocks recovery; never treat a present replacement as dead.
  assert.ok(['ABSENT', 'PRESENT'].includes(result.status));
});
