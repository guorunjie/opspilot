import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openOfflineBrowser } from '../src/rpa/offlineBrowser.js';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { openPersistentTask } from '../src/storage/persistentTask.js';
import { createTaskOwnership } from '../src/storage/taskOwnership.js';
import { createAsyncTaskAgent } from '../src/agent/asyncTaskAgent.js';
const root = await mkdtemp(path.join(tmpdir(), 'core-browser-interrupted-'));
const output = path.resolve('output/playwright/browser-interruption'); await mkdir(output, { recursive: true });
const store = openStateStore(path.join(root, 'task.sqlite'), 'tasks');
// Separate synthetic platform state survives browser closure. Never real data.
const platform = openStateStore(path.join(root, 'platform.sqlite'), 'synthetic-platform');
platform.save('price', { value: 2000, submissions: 0 }, 0);
const scope = { id: 'task', namespace: 'offline_demo', connectorId: 'synthetic-browser', storeId: 'store' };
const handle = openPersistentTask({ store, scope, create: true });
const ownership = createTaskOwnership({ store, scope });
let runtime, completedInvocation;
async function open() {
  runtime = await openOfflineBrowser({ browserType: chromium, headless: !process.argv.includes('--headed') });
  const value = platform.read('price').value.value;
  await runtime.load(`<html lang="zh-CN"><h1>合成药店 · 中断后只读核对</h1><p>仅用于离线恢复验收</p><button>提交模拟价格</button><output aria-label="模拟价格">${value}</output></html>`);
  await runtime.page.evaluate(() => document.querySelector('button').addEventListener('click', () => { document.querySelector('output').textContent = '1800'; }));
  console.log(await runtime.page.locator('body').ariaSnapshot());
}
const config = { ...handle, ownership, timeoutMs: 1500,
  planner: { proposePlan: async () => ({ items: [{ targetId: 'A', before: 2000, value: 1800 }] }) },
  writeCapabilityId: 'write', readCapabilityId: 'read',
  gateway: { get: id => ({ riskLevel: id === 'write' ? 'simulated_write' : 'readonly' }),
    invoke(id, request, { signal }) {
      assert.equal(request.planId, 'plan'); assert.equal(request.storeId, 'store');
      assert.equal(handle.getTask().approval.planId, 'plan');
      const invoked = runtime.run(async page => {
        if (id === 'write') {
          assert.equal(handle.getTask().status, 'EXECUTING');
          await page.getByRole('button', { name: '提交模拟价格' }).click();
          const saved = platform.read('price');
          platform.save('price', { value: Number(await page.getByRole('status', { name: '模拟价格' }).textContent()), submissions: saved.value.submissions + 1 }, saved.revision);
          // Simulate lost response AFTER the synthetic target changed.
          await page.locator('#response-that-never-arrives').waitFor({ timeout: 0 });
          return { status: 'SUBMITTED' };
        }
        assert.equal(handle.getTask().status, 'VERIFYING');
        return { planId: request.planId, connectorId: scope.connectorId, storeId: scope.storeId,
          items: [{ targetId: 'A', value: Number(await page.getByRole('status', { name: '模拟价格' }).textContent()) }] };
      }, { signal });
      completedInvocation = invoked.then(() => undefined, () => undefined);
      return invoked;
    } }
};
try {
  await open(); const agent = createAsyncTaskAgent(config);
  await agent.check(true); await agent.propose({ input: {}, planId: 'plan' }); await agent.approve({ planId: 'plan', confirmed: true });
  await assert.rejects(agent.execute({ runId: 'run' }), /timed out/);
  assert.equal(handle.getTask().status, 'UNKNOWN');
  await runtime.close(); await completedInvocation; await agent.whenIdle();
  assert.equal(runtime.snapshot().status, 'CLOSED');
  assert.equal(ownership.inspect().token, null);
  assert.deepEqual(platform.read('price').value, { value: 1800, submissions: 1 });
  await open(); const resumed = createAsyncTaskAgent({ ...config, ...openPersistentTask({ store, scope }) });
  assert.equal(resumed.snapshot().status, 'UNKNOWN');
  await assert.rejects(resumed.execute({ runId: 'again' }));
  assert.equal((await resumed.verify()).task.status, 'VERIFIED');
  assert.equal(platform.read('price').value.submissions, 1);
  await runtime.page.screenshot({ path: path.join(output, 'reconciled.png') });
  await runtime.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ actualChromium: true, scenario: 'response_lost_after_click',
    timedOutState: 'UNKNOWN', closedBeforeReopen: true, resumedReadback: 'VERIFIED', submissions: 1,
    simulated: true, realPlatformVerified: false, root }, null, 2));
  console.log('Browser interrupted write → confirmed close → read-only reconciliation PASS');
} finally { if (runtime) await runtime.close(); store.close(); platform.close(); }
