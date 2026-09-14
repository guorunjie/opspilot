import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const script of ['verify-installer.mjs', 'verify-packaged-demo.mjs']) {
  test(`${script} refuses non-CI use before creating files or launching a candidate`, t => {
    const root = mkdtempSync(path.join(tmpdir(), 'opspilot-ci-guard-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = fileURLToPath(new URL(`../scripts/${script}`, import.meta.url));
    const result = spawnSync(process.execPath, [file, path.join(root, 'nonexistent.exe')], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, GITHUB_ACTIONS: 'false', CI: 'false', RUNNER_TEMP: root }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError/);
    assert.deepEqual(readdirSync(root), []);
  });
}
