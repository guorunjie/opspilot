import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadLocalExecutorIdentity } from '../src/storage/localExecutorIdentity.js';
const fixture = run => {
  // macOS may expose tmpdir through /var -> /private/var. The fixture itself
  // must use a canonical path so this does not accidentally test link refusal.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'core-host-id-')));
  const dir = path.join(root, 'opspilot-open-core', 'desktop-runtime');
  fs.mkdirSync(dir, { recursive: true });
  try { run(dir); } finally { fs.rmSync(root, { recursive: true }); }
};
test('host identity persists, instance identity renews and portable data is untouched', () => fixture(dir => {
  const first = loadLocalExecutorIdentity(dir), second = loadLocalExecutorIdentity(dir);
  assert.equal(first.hostId, second.hostId);
  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal(first.pid, process.pid);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(fs.readdirSync(path.dirname(dir)), ['desktop-runtime']);
  fixture(other => assert.notEqual(loadLocalExecutorIdentity(other).hostId, first.hostId));
}));
test('corrupt and incomplete identities are preserved, never replaced', () => fixture(dir => {
  const file = path.join(dir, 'host-identity.json');
  for (const contents of ['', '{', '{}', '{"version":99,"hostId":"unknown"}', 'x'.repeat(513)]) {
    fs.writeFileSync(file, contents);
    assert.throws(() => loadLocalExecutorIdentity(dir));
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  }
}));
test('linked identity files and wrong directories are refused', () => fixture(dir => {
  const source = path.join(dir, 'source'); fs.writeFileSync(source, '{}');
  fs.linkSync(source, path.join(dir, 'host-identity.json'));
  assert.throws(() => loadLocalExecutorIdentity(dir), /Invalid executor identity file/);
  assert.throws(() => loadLocalExecutorIdentity(path.dirname(dir)), /directory/);
  assert.equal(fs.readFileSync(source, 'utf8'), '{}');
}));
