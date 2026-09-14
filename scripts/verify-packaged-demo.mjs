// DS-012 structure reviewed against the real Demo snapshot contract.
// CI-only test driver; the packaged app still uses the ephemeral runner profile.
import { _electron } from 'playwright';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { once } from 'node:events';
import { installRecoveryCrashProbe } from './recoveryCrashProbe.mjs';

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
  assert.equal(submitted.task.status, scenario === 'response_lost' ? 'UNKNOWN' : 'SUBMITTED');
  assert.equal(submitted.task.verifications.length, 0);
  await reopen(submitted);
  await submittedControls();
  await button('核对模拟平台结果').click();
  if (scenario === 'readback_unavailable') {
    await waitText('#action-state', 'UNKNOWN');
    const unknown = await snapshot();
    assert.equal(unknown.action.status, 'awaiting_readback');
    assert.equal(unknown.task.verifications.at(-1).exact, false);
    assert.equal(unknown.task.verifications.at(-1).items[0].observed, null);
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
  assert.equal(reviewed.task.verifications.at(-1).status, mismatch ? 'FAILED' : 'VERIFIED');
  assert.equal(reviewed.submissionCount, 1);
  assert.equal(reviewed.review.realPlatformVerified, false);
  assert.equal(reviewed.review.matchedCount, mismatch ? 0 : 1);
  assert.equal(reviewed.review.items.length, 1);
  assert.equal(reviewed.review.items[0].expected, 1800);
  assert.equal(reviewed.review.items[0].observed, mismatch ? 2000 : 1800);
  assert.equal(reviewed.review.actualProfitImpact, null);
  assert.equal(reviewed.task.status, mismatch ? 'FAILED' : 'VERIFIED');
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
  return { scenario, submissionCount: 1, status: reviewed.task.status };
}
async function supplementalConfirm(label, accept) {
  const waiting = page.waitForEvent('dialog');
  const clicked = button(`确认${label}预览`).click();
  const dialog = await waiting;
  assert.equal(dialog.type(), 'confirm');
  assert.match(dialog.message(), new RegExp(`确认本次${label}模拟`));
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await clicked;
}
async function supplementalRun(scenario) {
  await open();
  const initial = await snapshot();
  assert.equal(initial.diagnosis, null);
  assert.deepEqual(initial.supplemental, {}, 'Never reset a pre-existing supplemental task');
  assert.equal(initial.action, null);
  await button('运行演示诊断').click();
  for (const [kind, label] of [['inventory', '库存'], ['campaign', '活动']]) {
    await button(`预览${label}建议`).click();
    await supplementalConfirm(label, false);
    assert.equal((await snapshot()).supplemental[kind].task.approval, null);
    await supplementalConfirm(label, true);
    await waitText(`[data-kind="${kind}"]`, '已保存本次模拟确认');
    if (scenario !== 'normal') await page.locator(`[data-kind="${kind}"] summary`).click();
    const action = scenario === 'normal' ? `执行${label}模拟`
      : `模拟${label}${{ response_lost: '响应丢失', mismatch: '目标不一致', readback_unavailable: '首次回读不可用' }[scenario]}`;
    await button(action).click();
    await waitText(`[data-kind="${kind}"]`, '提交次数：1');
  }
  const submitted = await snapshot();
  assert.equal(submitted.submissionCount, 0, 'Supplemental tasks cannot execute price task');
  for (const record of Object.values(submitted.supplemental)) {
    assert.equal(record.task.status, scenario === 'response_lost' ? 'UNKNOWN' : 'SUBMITTED');
    assert.equal(record.review, null);
  }
  await reopen(submitted);
  for (const [kind, label] of [['inventory', '库存'], ['campaign', '活动']]) {
    assert.equal(await button(`确认${label}预览`).count(), 0);
    assert.equal(await button(`执行${label}模拟`).isDisabled(), true);
    await button(`核对${label}模拟结果`).click();
    if (scenario === 'readback_unavailable') {
      await waitText(`[data-kind="${kind}"]`, '复盘：结果未知（UNKNOWN）');
      const unknown = await snapshot();
      assert.equal(unknown.supplemental[kind].review.items[0].observed, null);
      assert.equal(unknown.supplemental[kind].submissionCount, 1);
      await page.locator('#additional-section').screenshot({ path: path.join(output, `${kind}-${scenario}-unknown.png`) });
      await reopen(unknown);
      assert.equal(await button(`执行${label}模拟`).isDisabled(), true);
      await button(`核对${label}模拟结果`).click();
    }
    await waitText(`[data-kind="${kind}"]`, `复盘：${scenario === 'mismatch' ? '模拟目标不一致（FAILED）' : '模拟回读一致（VERIFIED）'}`);
  }
  const reviewed = await snapshot();
  const results = [];
  for (const kind of ['inventory', 'campaign']) {
    const record = reviewed.supplemental[kind];
    assert.equal(record.task.status, scenario === 'mismatch' ? 'FAILED' : 'VERIFIED');
    assert.equal(record.submissionCount, 1);
    assert.equal(record.task.history.filter(event => event.type === 'START').length, 1);
    assert.equal(record.review.realPlatformVerified, false);
    assert.equal(record.review.actualProfitImpact, null);
    assert.equal(record.review.items.length, 1);
    const expected = kind === 'inventory' ? 12 : 1;
    assert.equal(record.review.items[0].expected, expected);
    assert.equal(record.review.items[0].observed, scenario === 'mismatch' ? 0 : expected);
    results.push({ kind, scenario, submissionCount: 1, status: record.task.status });
  }
  await page.locator('#additional-section').screenshot({ path: path.join(output, `supplemental-${scenario}-review.png`) });
  await reopen(reviewed);
  await resetDialog(false);
  assert.deepEqual(await snapshot(), reviewed);
  await resetDialog(true);
  await waitText('#action-state', '尚未确认。');
  const reset = await snapshot();
  assert.notEqual(reset.sessionId, reviewed.sessionId);
  assert.deepEqual(reset.supplemental, {});
  assert.equal(reset.diagnosis, null);
  await reopen(reset);
  await close();
  assert.deepEqual(errors, []);
  return results;
}
async function recoveryRun(point) {
  await open();
  console.log(await page.locator('body').ariaSnapshot());
  const initial = await snapshot();
  assert.equal(initial.diagnosis, null, 'Never discard pre-existing records for recovery checks');
  assert.equal(initial.action, null);
  await button('运行演示诊断').click(); await button('查看跟价预览').click();
  await page.getByRole('checkbox').check(); await button('确认本次预览').click();
  await installRecoveryCrashProbe(app, point);
  if (point.startsWith('verify-')) {
    await button('执行模拟操作').click(); await waitText('#action-state', 'SUBMITTED');
  }
  const ownedPid = await app.evaluate(() => process.pid);
  const exited = once(app.process(), 'exit');
  let watchdog = false;
  const timer = setTimeout(() => {
    watchdog = true;
    // Only the exact process launched and identified by this test is stopped.
    try { process.kill(ownedPid, 'SIGKILL'); } catch { /* Exit may already be observed. */ }
  }, 15000);
  const clicked = button(point.startsWith('verify-') ? '核对模拟平台结果' : '执行模拟操作').click().catch(() => {});
  let exit;
  try { exit = await exited; await clicked; } finally { clearTimeout(timer); }
  app = null;
  assert.equal(watchdog, false, 'Crash probe must reach its boundary, not watchdog termination');
  assert.notEqual(exit[0], 0);
  await open();
  const before = await snapshot();
  assert.equal(before.task.status, point === 'verify-saved' ? 'VERIFIED' : point === 'verify-started' ? 'VERIFYING' : 'EXECUTING');
  const count = ['started', 'reserved'].includes(point) ? 0 : 1;
  assert.equal(before.submissionCount, count);
  assert.equal(before.recovery.canRecover, true);
  console.log(await page.locator('body').ariaSnapshot());
  await page.screenshot({ path: path.join(output, `recovery-${point}-ready.png`) });
  // Controlled answers exercise main-process dialog handling, not native UI
  // interaction. Native Windows source interaction is a separate acceptance.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await button('恢复待核实记录（不重新提交）').click();
  assert.deepEqual(await snapshot(), before);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await button('恢复待核实记录（不重新提交）').click();
  const recovered = await snapshot();
  assert.equal(recovered.recovery.required, false);
  assert.equal(recovered.submissionCount, count);
  if (point === 'verify-saved') {
    assert.deepEqual(recovered.task, before.task); assert.deepEqual(recovered.review, before.review);
  } else {
    assert.equal(recovered.task.status, 'UNKNOWN'); assert.equal(recovered.review, null);
  }
  await reopen(recovered);
  assert.equal(await button('执行模拟操作').isDisabled(), true);
  if (point !== 'verify-saved') await button('核对模拟平台结果').click();
  const status = count ? 'VERIFIED' : 'FAILED';
  await waitText('#action-state', status);
  const reviewed = await snapshot();
  assert.equal(reviewed.task.status, status); assert.equal(reviewed.submissionCount, count);
  assert.equal(reviewed.task.history.filter(event => event.type === 'START').length, 1);
  await page.locator('#action-state').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `recovery-${point}-review.png`) });
  await resetDialog(true); await waitText('#action-state', '尚未确认。'); await close();
  return { point, status, submissionCount: count, crashExit: exit };
}

try {
  const scenarios = [];
  for (const scenario of ['normal', 'response_lost', 'mismatch', 'readback_unavailable']) scenarios.push(await scenarioRun(scenario));
  const supplemental = [];
  for (const scenario of ['normal', 'response_lost', 'mismatch', 'readback_unavailable']) supplemental.push(...await supplementalRun(scenario));
  // Repeat both normal flows after the final reset, not just an empty snapshot.
  await supplementalRun('normal');
  const recovery = [];
  for (const point of ['started', 'reserved', 'written', 'verify-started', 'verify-saved']) recovery.push(await recoveryRun(point));
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ version: expectedVersion,
    platform: process.platform, arch: process.arch, scenarios, supplemental, supplementalResetRepeat: true, recovery,
    recoveryScope: 'Owned packaged process force-terminated after SQLite writes using a test-only injected probe; recovery dialog answers controlled, not native dialog interaction or OS power-loss acceptance.',
    scope: 'Actual packaged app UI in ephemeral CI; not interactive installer, clean end-user machine, Gatekeeper/notarization or real-platform acceptance' }, null, 2) + '\n');
} finally { await close(); }
