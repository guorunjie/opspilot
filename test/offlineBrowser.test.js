import test from 'node:test';
import assert from 'node:assert/strict';
import { openOfflineBrowser } from '../src/rpa/offlineBrowser.js';
function fake(options = {}) {
  let connected = true, closed = false, closes = 0;
  const calls = [];
  const page = { isClosed: () => closed, setContent: async html => calls.push(['content', html]) };
  const context = { setDefaultTimeout: value => calls.push(['timeout', value]), setDefaultNavigationTimeout() {},
    route: async (...args) => { calls.push(['route', ...args]); if (options.setupFails) throw new Error('setup failed'); },
    routeWebSocket: async (...args) => calls.push(['websocket', ...args]), newPage: async () => page, on() {} };
  const browser = { newContext: async opts => { calls.push(['context', opts]); return context; },
    isConnected: () => connected, close: async () => { closes++; if (options.closeFails) throw new Error('close failed');
      if (!options.unconfirmed) { connected = false; closed = true; } } };
  const browserType = { name: () => 'chromium', launch: async opts => { calls.push(['launch', opts]); return browser; } };
  return { browserType, calls, get closes() { return closes; } };
}
test('fresh offline context blocks routes, websocket and fixture scripts', async () => {
  const f = fake(); const runtime = await openOfflineBrowser({ browserType: f.browserType });
  const options = f.calls.find(c => c[0] === 'context')[1];
  assert.equal(options.offline, true); assert.equal(options.serviceWorkers, 'block');
  assert.equal(options.acceptDownloads, false); assert.deepEqual(options.permissions, []);
  let aborted, socketClosed = false;
  await f.calls.find(c => c[0] === 'route')[2]({ abort: reason => { aborted = reason; } });
  await f.calls.find(c => c[0] === 'websocket')[2]({ close: () => { socketClosed = true; } });
  assert.equal(aborted, 'blockedbyclient'); assert.equal(socketClosed, true);
  await runtime.load('<p>synthetic</p>');
  assert.match(f.calls.find(c => c[0] === 'content')[1], /script-src 'none'/);
  await runtime.close(); await runtime.close(); assert.equal(f.closes, 1);
  await assert.rejects(runtime.load('again'), /not open/);
});
test('setup failure closes only the newly launched browser', async () => {
  const f = fake({ setupFails: true });
  await assert.rejects(openOfflineBrowser({ browserType: f.browserType }), /setup failed/);
  assert.equal(f.closes, 1);
});
test('close failure or unconfirmed closure remains UNKNOWN', async () => {
  for (const options of [{ closeFails: true }, { unconfirmed: true }]) {
    const f = fake(options); const runtime = await openOfflineBrowser({ browserType: f.browserType });
    await assert.rejects(runtime.close()); assert.equal(runtime.snapshot().status, 'UNKNOWN');
    await assert.rejects(runtime.load('no reuse'), /not open/);
  }
});
test('setup plus cleanup failure retains both causes', async () => {
  const f = fake({ setupFails: true, closeFails: true });
  await assert.rejects(openOfflineBrowser({ browserType: f.browserType }), e => e instanceof AggregateError && e.errors.length === 2);
});
test('invalid launcher and timeout fail before launch', async () => {
  const f = fake();
  await assert.rejects(openOfflineBrowser({ browserType: f.browserType, timeoutMs: 0 }));
  await assert.rejects(openOfflineBrowser({ browserType: { ...f.browserType, name: () => 'firefox' } }));
  assert.deepEqual(f.calls, []);
});

test('cancel closes owned browser and operation must settle before run rejects', async () => {
  const f = fake(); const runtime = await openOfflineBrowser({ browserType: f.browserType });
  const controller = new AbortController(); let settle;
  const pending = runtime.run(() => new Promise(resolve => { settle = resolve; }), { signal: controller.signal });
  await assert.rejects(runtime.run(async () => {}), /busy/);
  controller.abort(); await runtime.close();
  assert.equal(runtime.snapshot().status, 'CLOSED');
  settle('late success'); await assert.rejects(pending, /abort/i);
  assert.equal(f.closes, 1);
});
test('already aborted signal never starts operation', async () => {
  const f = fake(); const runtime = await openOfflineBrowser({ browserType: f.browserType }); let calls = 0;
  await assert.rejects(runtime.run(() => { calls++; }, { signal: AbortSignal.abort() }));
  assert.equal(calls, 0); await runtime.close();
});
test('cancel cleanup failure propagates and status remains UNKNOWN', async () => {
  const f = fake({ closeFails: true }); const runtime = await openOfflineBrowser({ browserType: f.browserType });
  const controller = new AbortController(); let settle;
  const pending = runtime.run(() => new Promise(resolve => { settle = resolve; }), { signal: controller.signal });
  controller.abort(); settle('not success');
  await assert.rejects(pending, AggregateError); assert.equal(runtime.snapshot().status, 'UNKNOWN');
});
