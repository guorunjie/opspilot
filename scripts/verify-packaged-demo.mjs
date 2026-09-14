// DS-012 structure reviewed against the real Demo snapshot contract.
// CI-only test driver; the packaged app still uses the ephemeral runner profile.
import { _electron } from 'playwright';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'CI only, never silently skip');
assert.equal(process.env.CI, 'true');
assert.ok(['win32', 'darwin'].includes(process.platform));
const executablePath = process.argv[2];
assert.ok(executablePath && path.isAbsolute(executablePath));
const relative = path.relative(await realpath(process.env.RUNNER_TEMP), await realpath(executablePath));
assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'Only a temporary CI installation');
const repoRoot = path.resolve(import.meta.dirname, '..');
const expectedVersion = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
const output = path.join(repoRoot, 'output/playwright/packaged-ci');
await mkdir(output, { recursive: true });
let app;
let page;
const errors = [];
const button = name => page.getByRole('button', { name, exact: true });
const snapshot = () => page.evaluate(() => window.opspilotDemo.command('snapshot'));
const waitText = (selector, text) => page.waitForFunction(([s, t]) => document.querySelector(s)?.textContent.includes(t), [selector, text]);
async function open() {
  app = await _electron.launch({ executablePath, args: [], timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), executable: process.execPath }));
  assert.equal(identity.packaged, true);
  assert.equal(identity.version, expectedVersion);
  assert.equal(await realpath(identity.executable), await realpath(executablePath));
  await page.waitForFunction(() => document.querySelector('#status')?.textContent && !document.querySelector('#status').textContent.includes('正在加载'));
}
async function close() { if (app) { const owned = app; app = null; await owned.close(); } }
async function reopen(expected) { await close(); await open(); assert.deepEqual(await snapshot(), expected); }
async function resetDialog(accept) {
  const waiting = page.waitForEvent('dialog');
  const clicked = button('复位演示').click();
  const dialog = await waiting;
  assert.match(dialog.message(), /不影响真实门店/);
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await clicked;
}
async function submittedControls() {
  assert.equal(await page.locator('#authorization-record').isVisible(), true);
  assert.match(await page.locator('#authorization-record').innerText(), /已保存本次预览的模拟确认/);
  assert.equal(await page.getByRole('checkbox').count(), 0);
  assert.equal(await button('执行模拟操作').isDisabled(), true);
}
async function scenarioRun(scenario) {
  await open();
  console.log(await page.locator('body').ariaSnapshot());
  const initial = await snapshot();
  assert.equal(initial.action, null, 'Never reset a pre-existing task to make a test pass');
  assert.equal(initial.diagnosis, null);
  assert.equal(initial.simulated, true);
  assert.equal(initial.realPlatformVerified, false);
  await button('运行演示诊断').click();
  await button('查看跟价预览').click();
  await page.getByRole('checkbox').check();
  await button('确认本次预览').click();
  await page.getByRole('combobox').selectOption(scenario);
  await button('执行模拟操作').click();
  await waitText('#action-state', '提交次数：1');
  const submitted = await snapshot();
  assert.equal(submitted.action.status, 'awaiting_readback');
  assert.equal(submitted.submissionCount, 1);
  assert.equal(submitted.review, null);
  await reopen(submitted);
  await submittedControls();
  await button('核对模拟平台结果').click();
  if (scenario === 'readback_unavailable') {
    await waitText('#action-state', 'UNKNOWN');
    const unknown = await snapshot();
    assert.equal(unknown.action.status, 'awaiting_readback');
    assert.equal(unknown.action.evidence, null);
    assert.equal(unknown.review, null);
    assert.equal(unknown.submissionCount, 1);
    assert.equal(unknown.readbackAttempts.length, 1);
    assert.equal(unknown.readbackAttempts[0].status, 'UNKNOWN');
    await page.screenshot({ path: path.join(output, `${scenario}-unknown.png`), fullPage: true });
    await reopen(unknown);
    await submittedControls();
    await button('再次核对（不重复提交）').click();
  }
  await waitText('#review', '项模拟回读一致');
  const reviewed = await snapshot();
  const mismatch = scenario === 'mismatch';
  assert.equal(reviewed.action.status, mismatch ? 'readback_inconsistent' : 'succeeded');
  assert.equal(reviewed.submissionCount, 1);
  assert.equal(reviewed.review.realPlatformVerified, false);
  assert.equal(reviewed.review.matchedCount, mismatch ? 0 : 1);
  assert.equal(reviewed.review.items.length, 1);
  assert.equal(reviewed.review.items[0].expected, 1800);
  assert.equal(reviewed.review.items[0].observed, mismatch ? 2000 : 1800);
  assert.equal(reviewed.review.actualProfitImpact, null);
  await page.screenshot({ path: path.join(output, `${scenario}-review.png`), fullPage: true });
  await reopen(reviewed);
  await resetDialog(false);
  assert.deepEqual(await snapshot(), reviewed);
  await resetDialog(true);
  await waitText('#action-state', '尚未确认。');
  const reset = await snapshot();
  assert.notEqual(reset.sessionId, reviewed.sessionId);
  for (const key of ['action', 'preview', 'review', 'diagnosis']) assert.equal(reset[key], null);
  assert.equal(reset.submissionCount, 0);
  assert.deepEqual(reset.readbackAttempts, []);
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  await reopen(reset);
  await close();
  assert.deepEqual(errors, []);
  return { scenario, submissionCount: 1, status: reviewed.action.status };
}
try {
  const scenarios = [];
  for (const scenario of ['normal', 'response_lost', 'mismatch', 'readback_unavailable']) scenarios.push(await scenarioRun(scenario));
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ version: expectedVersion,
    platform: process.platform, arch: process.arch, scenarios,
    scope: 'Actual packaged app UI in ephemeral CI; not interactive installer, clean end-user machine, Gatekeeper/notarization or real-platform acceptance' }, null, 2) + '\n');
} finally { await close(); }
