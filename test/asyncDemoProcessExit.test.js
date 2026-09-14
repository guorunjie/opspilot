import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStateStore } from '../src/storage/sqliteStateStore.js';
import { createAsyncStoreDemo } from '../src/demo/asyncStoreDemo.js';
import { openAsyncPriceSession } from '../src/demo/asyncPriceSession.js';
import { createTaskOwnership } from '../src/storage/taskOwnership.js';

const moduleUrl = file => JSON.stringify(pathToFileURL(path.resolve(file)).href);
for (const point of ['started', 'reserved', 'target-written']) {
  test(`abrupt child exit at ${point} preserves fences and permits confirmed read-only reconciliation`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'core-demo-exit-'));
    const file = path.join(root, 'demo.sqlite');
    let store;
    try {
      const source = `
        import {openStateStore} from ${moduleUrl('src/storage/sqliteStateStore.js')};
        import {createAsyncStoreDemo} from ${moduleUrl('src/demo/asyncStoreDemo.js')};
        const raw=openStateStore(process.argv[1], 'crash-demo');
        const store={read:raw.read,save(key,value,revision){
          const saved=raw.save(key,value,revision);
          if (${JSON.stringify(point)}==='reserved' && key.startsWith('async-price:') && value.scenario!==null && value.submissionCount===0) process.exit(23);
          if (${JSON.stringify(point)}==='started' && key.startsWith('task:') && value.task?.status==='EXECUTING') process.exit(23);
          if (${JSON.stringify(point)}==='target-written' && key.startsWith('async-price:') && value.submissionCount===1) process.exit(23);
          return saved;
        }};
        const demo=createAsyncStoreDemo({store});
        const call=async(method,input)=>{await demo[method](input);await demo.whenIdle();};
        await call('diagnose'); const plan=await demo.preview(); await demo.whenIdle();
        await call('confirm',{previewId:plan.id,confirmed:true});
        await call('execute',{scenario:'normal'});
        process.exit(99);`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, file],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 23, child.stderr);
      // Exact child has terminated; no time-based inference or live-owner takeover.
      store = openStateStore(file, 'crash-demo');
      const demo = createAsyncStoreDemo({ store });
      const before = demo.snapshot();
      assert.equal(before.task.status, 'EXECUTING');
      assert.equal(before.review, null);
      assert.equal(before.submissionCount, point === 'target-written' ? 1 : 0);
      assert.throws(() => demo.execute(), /owned/);
      assert.throws(() => demo.reset({ confirmed: true }), /owned/);
      const shell = createTaskOwnership({ store, scope: { id: 'async-demo-shell', namespace: 'offline_demo', connectorId: 'offline_demo', storeId: 'demo-store' } });
      const priceOwner = createTaskOwnership({ store, scope: before.task });
      for (const owner of [shell, priceOwner]) {
        const token = owner.inspect().token;
        assert.ok(token);
        assert.throws(() => owner.releaseAbandoned({ token }), /termination/);
        owner.releaseAbandoned({ token, executorStopped: true });
      }
      const price = openAsyncPriceSession({ store, sessionId: before.sessionId, products: before.products });
      await price.recover({ previousExecutorStopped: true });
      await price.whenIdle();
      assert.equal(price.snapshot().task.status, 'UNKNOWN');
      await price.readback(); await price.whenIdle();
      assert.equal(price.snapshot().task.status, point === 'target-written' ? 'VERIFIED' : 'FAILED');
      assert.equal(price.snapshot().platform.submissionCount, before.submissionCount);
      await assert.rejects(price.execute(), /Approved unexecuted/);
      assert.equal(createAsyncStoreDemo({ store }).snapshot().task.status, price.snapshot().task.status);
    } finally {
      store?.close();
      rmSync(root, { recursive: true });
    }
  });
}
