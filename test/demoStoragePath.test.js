import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareDemoDatabasePath } from '../src/storage/demoStoragePath.js';

test('Demo directory junction cannot redirect creation into another directory', t => {
  // macOS may expose its temporary directory through /var -> /private/var.
  // Resolve the test root, while leaving intentionally created links intact.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opspilot-path-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'unrelated'); fs.mkdirSync(outside);
  const appData = path.join(root, 'appData'); fs.mkdirSync(appData);
  fs.symlinkSync(outside, path.join(appData, 'opspilot-open-core'), 'junction');
  assert.throws(() => prepareDemoDatabasePath(path.join(appData, 'opspilot-open-core', 'offline-demo')), /链接/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('Demo database and journal cannot alias another file through hard links', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opspilot-file-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'opspilot-open-core', 'offline-demo');
  const database = prepareDemoDatabasePath(dataDir);
  assert.equal(database, path.join(dataDir, 'pharmacy.sqlite'));
  const sentinel = path.join(root, 'sentinel'); fs.writeFileSync(sentinel, 'unchanged');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.linkSync(sentinel, database + suffix);
    assert.throws(() => prepareDemoDatabasePath(dataDir), /链接/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
    fs.unlinkSync(database + suffix);
  }
});
