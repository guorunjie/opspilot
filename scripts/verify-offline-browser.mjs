import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openOfflineBrowser } from '../src/rpa/offlineBrowser.js';
import { openPageCDP } from '../src/rpa/pageCDP.js';
import { compileBrowserWorkflow, runBrowserWorkflow } from '../src/rpa/browserWorkflow.js';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { openPersistentTask } from '../src/storage/persistentTask.js';
import { createTaskOwnership } from '../src/storage/taskOwnership.js';
import { createAsyncTaskAgent } from '../src/agent/asyncTaskAgent.js';

const root = await mkdtemp(path.join(tmpdir(), 'opspilot-browser-acceptance-'));
const output = path.resolve('output/playwright/offline-browser');
await mkdir(output, { recursive: true });
const store = openStateStore(path.join(root, 'tasks.sqlite'), 'browser-acceptance');
const scope = { id: 'price', namespace: 'offline_demo', connectorId: 'synthetic-browser', storeId: 'demo-store' };
let runtime;
try {
  runtime = await openOfflineBrowser({ browserType: chromium, headless: !process.argv.includes('--headed') });
  const page = runtime.page;
  await runtime.load(`<html lang="zh-CN"><title>OpsPilot 浏览器隔离验收</title><style>body{font:20px sans-serif;padding:50px;background:#f3f7f5}button{padding:12px}output{display:block;margin:20px 0}</style>
    <h1>合成药店 · 浏览器执行验收</h1><p>不连接真实店铺，仅用于验证模拟点击和独立回读。</p>
    <label>目标价格（分）<input id="price" value="1800"></label><button id="submit">提交模拟价格</button>
    <output id="observed" aria-label="模拟平台价格">2000</output><p id="count">提交次数：0</p><script>window.fixtureScriptRan = true;</script></html>`);
  assert.equal(await page.evaluate(() => window.fixtureScriptRan), undefined);
  // Trusted harness installs synthetic behavior; HTML-provided scripts remain blocked.
  await page.evaluate(() => {
    let count = 0;
    document.querySelector('#submit').addEventListener('click', () => {
      document.querySelector('#observed').textContent = document.querySelector('#price').value;
      document.querySelector('#count').textContent = `提交次数：${++count}`;
    });
  });
  console.log(await page.locator('body').ariaSnapshot());
  assert.deepEqual(await page.context().cookies(), []);
  assert.equal(await page.evaluate(async () => { try { await fetch('https://example.invalid/no-network'); return true; } catch { return false; } }), false);
  const task = openPersistentTask({ store, scope, create: true });
  const ownership = createTaskOwnership({ store, scope });
  const writeWorkflow = { version: 1, id: 'price-write', steps: [
    { id: 'before', type: 'assertText', selector: '#observed', value: '2000' },
    { id: 'target', type: 'fill', selector: '#price', value: '1800' },
    { id: 'submit', type: 'click', selector: '#submit' }
  ] };
  const readWorkflow = { version: 1, id: 'price-read', steps: [{ id: 'price', type: 'readText', selector: '#observed' }] };
  const writeDigest = compileBrowserWorkflow(writeWorkflow).digest;
  const journal = event => {
    const saved = store.read('workflow-journal');
    store.save('workflow-journal', [...(saved?.value ?? []), event], saved?.revision ?? 0);
  };
  const gateway = {
    get: id => ({ riskLevel: id === 'write' ? 'simulated_write' : 'readonly' }),
    async invoke(id, request, { signal }) {
      assert.equal(request.storeId, scope.storeId);
      assert.equal(request.planId, 'plan-1');
      assert.deepEqual(request.items, [{ targetId: 'A', before: 2000, value: 1800 }]);
      const saved = task.getTask();
      assert.equal(saved.approval.planId, request.planId);
      if (id === 'write') {
        assert.equal(saved.status, 'EXECUTING');
        const result = await runBrowserWorkflow({ runtime, workflow: writeWorkflow, context: request, signal,
          preconditions: () => runtime.snapshot().status === 'OPEN',
          authorize: ({ workflow, context }) => workflow.digest === writeDigest && context.planId === 'plan-1'
            && task.getTask().status === 'EXECUTING' && task.getTask().approval.planId === context.planId,
          onStep: journal });
        assert.equal(result.status, 'COMPLETED');
        return { status: 'SUBMITTED' };
      }
      assert.equal(saved.status, 'VERIFYING');
      const result = await runBrowserWorkflow({ runtime, workflow: readWorkflow, context: request, signal,
        preconditions: () => task.getTask().status === 'VERIFYING', onStep: journal });
      const raw = result.outputs.find(item => item.stepId === 'price')?.value;
      const value = typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
      return { planId: request.planId, storeId: scope.storeId, connectorId: scope.connectorId, items: [{ targetId: 'A', value }] };
    }
  };
  const agent = createAsyncTaskAgent({ ...task, ownership, gateway, writeCapabilityId: 'write', readCapabilityId: 'read',
    planner: { proposePlan: async () => ({ items: [{ targetId: 'A', before: 2000, value: 1800 }] }) } });
  await agent.check(true); await agent.propose({ input: {}, planId: 'plan-1' });
  await assert.rejects(agent.execute({ runId: 'unapproved' }));
  assert.equal(await page.locator('#count').textContent(), '提交次数：0');
  await agent.approve({ planId: 'plan-1', confirmed: true });
  assert.equal((await agent.execute({ runId: 'run-1' })).task.status, 'SUBMITTED');
  assert.equal(task.getTask().verifications.length, 0);
  assert.equal((await agent.verify()).task.status, 'VERIFIED');
  await assert.rejects(agent.execute({ runId: 'duplicate' }));
  assert.equal(await page.locator('#count').textContent(), '提交次数：1');
  assert.equal(store.read('workflow-journal').value.length, 8);
  const cdp = await openPageCDP({ context: page.context(), page, simulated: true,
    scope: { namespace: scope.namespace, taskId: scope.id, planId: 'plan-1', runId: 'run-1', connectorId: scope.connectorId, storeId: scope.storeId } });
  const dom = await cdp.readDOM('#observed');
  assert.equal(dom.status, 'CAPTURED'); assert.match(dom.artifact.bytes.toString('utf8'), />1800<\/output>/);
  assert.equal((await cdp.readDOM('#absent')).status, 'MISSING');
  const capture = await cdp.screenshot();
  await writeFile(path.join(output, 'cdp-evidence.png'), capture.bytes);
  await writeFile(path.join(output, 'cdp-evidence.json'), JSON.stringify({ dom: dom.artifact.record, screenshot: capture.record }, null, 2));
  await cdp.detach(); await assert.rejects(cdp.screenshot());
  await page.screenshot({ path: path.join(output, 'verified.png') });
  assert.equal((await runtime.close()).status, 'CLOSED');
  assert.equal(page.isClosed(), true);
  assert.equal((await runtime.close()).status, 'CLOSED');
  await assert.rejects(runtime.load('<p>must not reopen</p>'));
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ simulatedBrowserVerified: true, submittedBeforeVerified: true,
    oneClick: true, closed: true, cookieCount: 0, fetchBlocked: true, cdpDOMAndScreenshot: true, workflowJournalEvents: 8, database: path.join(root, 'tasks.sqlite'),
    scope: 'Actual isolated Chromium + async Task + SQLite; not installed UI or real platform' }, null, 2));
  console.log('Offline browser async journey PASS');
} finally { if (runtime) await runtime.close(); store.close(); }
