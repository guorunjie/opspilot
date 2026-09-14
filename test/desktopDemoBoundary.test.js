import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { startOfflineDemo } from "../desktop/demoRuntime.cjs";
import { createOfflineStoreDemo } from "../src/demo/offlineStoreDemo.js";

test("demo boot isolates paths before readiness and denies external requests and foreign IPC", async (t) => {
  const events = [];
  const listeners = {}, focusEvents = [];
  let request, handler, permission, popup;
  const isolatedSession = {
    webRequest: { onBeforeRequest: (fn) => { request = fn; } },
    setPermissionRequestHandler: (fn) => { permission = fn; },
    setPermissionCheckHandler: (fn) => assert.equal(fn(), false)
  };
  class Window {
    constructor(options) {
      this.options = options;
      this.webContents = { mainFrame: {}, setWindowOpenHandler: (fn) => { popup = fn; }, on() {} };
    }
    async loadFile(file) { this.file = file; }
    isDestroyed() { return false; }
    isMinimized() { return true; }
    restore() { focusEvents.push('restore'); }
    show() { focusEvents.push('show'); }
    focus() { focusEvents.push('focus'); }
  }
  const result = await startOfflineDemo({
    app: { getPath: name => { assert.equal(name, 'appData'); return path.resolve('output/test-app-data'); }, setName() {}, setPath: (name) => events.push(name), requestSingleInstanceLock: () => { events.push('lock'); return true; }, commandLine: { appendSwitch() {} }, whenReady: async () => events.push("ready"), on: (name, fn) => { listeners[name] = fn; }, quit() {} },
    BrowserWindow: Window,
    ipcMain: { handle: (_name, fn) => { handler = fn; }, removeHandler() {} },
    session: { fromPartition: (name, options) => { assert.ok(!name.startsWith("persist:")); assert.equal(options.cache, false); return isolatedSession; } }
  }, ({ dataDir }) => {
    assert.equal(dataDir, path.resolve('output/test-app-data/opspilot-open-core/offline-demo'));
    return createOfflineStoreDemo();
  });
  t.after(() => fs.rm(result.cache, { recursive: true, force: true }));
  assert.deepEqual(events, ["userData", "lock", "sessionData", "ready"]);
  assert.equal(result.window.options.webPreferences.nodeIntegration, false);
  assert.equal(result.window.options.webPreferences.sandbox, true);
  for (const url of ["https://yiyao.meituan.com/", "http://127.0.0.1:4787/", "file:///C:/private.json", "ws://localhost:9333/"]) {
    request({ url }, (decision) => assert.equal(decision.cancel, true));
  }
  request({ url: pathToFileURL(path.resolve("desktop/demo/index.html")).href }, (decision) => assert.equal(decision.cancel, false));
  permission(null, "clipboard-read", (allowed) => assert.equal(allowed, false));
  assert.deepEqual(popup(), { action: "deny" });
  assert.throws(() => handler({ sender: {} }, "snapshot"), /拒绝/);
  const event = { sender: result.window.webContents, senderFrame: result.window.webContents.mainFrame };
  assert.throws(() => handler(event, "constructor"), /拒绝/);
  assert.throws(() => handler(event, "install-tasks"), /拒绝/);
  assert.equal(handler(event, "snapshot").mode, "offline_demo");
  const before = handler(event, 'snapshot');
  listeners['second-instance']({}, ['execute', '--confirmed=true'], '/', { command: 'reset' });
  assert.deepEqual(focusEvents, ['restore', 'show', 'focus']);
  assert.deepEqual(handler(event, 'snapshot'), before);
});

test('secondary launch exits before readiness, browser session, database or IPC creation', async () => {
  let quits = 0;
  const paths = [];
  const result = await startOfflineDemo({ app: {
    getPath: () => path.resolve('output/test-app-data'), setName() {},
    setPath: (name, value) => paths.push([name, value]),
    requestSingleInstanceLock: () => false, quit: () => { quits++; },
    whenReady: () => assert.fail('Secondary must not reach readiness')
  } }, () => assert.fail('Secondary must not open data'));
  assert.deepEqual(result, { secondary: true });
  assert.equal(quits, 1);
  assert.deepEqual(paths, [['userData', path.resolve('output/test-app-data/opspilot-open-core/desktop-runtime')]]);
});

for (const command of ['recover', 'upgrade']) for (const answer of [0, 1]) test(`desktop ${command} requires main-process dialog answer ${answer}, ignoring renderer proof`, async t => {
  let handler, resolveDialog, recovered = 0;
  class Window {
    constructor() { this.webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {} }; }
    async loadFile() {}
  }
  const result = await startOfflineDemo({
    app: { getPath: () => path.resolve('output/test-app-data'), setName() {}, setPath() {}, requestSingleInstanceLock: () => true,
      commandLine: { appendSwitch() {} }, whenReady: async () => {}, on() {}, quit() {} },
    BrowserWindow: Window,
    ipcMain: { handle: (_, fn) => { handler = fn; }, removeHandler() {} },
    session: { fromPartition: () => ({ webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    dialog: { showMessageBox: (_window, options) => {
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
      return new Promise(resolve => { resolveDialog = resolve; });
    } }
  }, () => ({ snapshot: () => ({ recovery: { canRecover: true }, legacyUpgrade: { available: true, revision: 7 }, recovered }),
    recover: input => { assert.deepEqual(input, { confirmed: true }); recovered++; return { recovered }; },
    upgrade: input => { assert.deepEqual(input, { confirmed: true, expectedRevision: 7 }); recovered++; return { recovered }; } }));
  t.after(() => fs.rm(result.cache, { recursive: true, force: true }));
  const event = { sender: result.window.webContents, senderFrame: result.window.webContents.mainFrame };
  const operation = handler(event, command, { confirmed: true, expectedRevision: 999, previousExecutorStopped: true, token: 'injected' });
  await Promise.resolve();
  assert.equal(recovered, 0);
  assert.throws(() => handler(event, command), /仍在进行/);
  assert.equal(handler(event, 'snapshot').recovered, 0);
  resolveDialog({ response: answer }); await operation;
  assert.equal(recovered, answer);
});

for (const responseFailure of [true, false]) for (const confirmedIdle of [true, false]) test(`desktop response failure=${responseFailure}; idle confirmation=${confirmedIdle}`, async t => {
  let handler, completePreview, markIdle, rejectIdle;
  const listeners = {};
  let previewed = false, resets = 0, quits = 0;
  const idle = new Promise((resolve, reject) => { markIdle = resolve; rejectIdle = reject; });
  class Window {
    constructor() { this.webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {} }; }
    async loadFile() {}
  }
  const result = await startOfflineDemo({
    app: { getPath: () => path.resolve('output/test-app-data'), setName() {}, setPath() {}, requestSingleInstanceLock: () => true,
      commandLine: { appendSwitch() {} }, whenReady: async () => {},
      on: (name, fn) => { listeners[name] = fn; }, quit: () => { quits++; } },
    BrowserWindow: Window,
    ipcMain: { handle: (_, fn) => { handler = fn; }, removeHandler() {} },
    session: { fromPartition: () => ({ webRequest: { onBeforeRequest() {} },
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) }
  }, () => ({ snapshot: () => ({ previewed }),
    preview: () => new Promise((resolve, reject) => { completePreview = () => {
      previewed = true;
      if (responseFailure) reject(new Error('timed out; outcome unknown')); else resolve();
    }; }),
    reset: () => { resets++; }, whenIdle: () => idle }));
  t.after(() => fs.rm(result.cache, { recursive: true, force: true }));
  const event = { sender: result.window.webContents, senderFrame: result.window.webContents.mainFrame };
  const operation = handler(event, 'preview');
  const response = responseFailure ? assert.rejects(operation, /timed out/) : operation;
  await Promise.resolve();
  assert.deepEqual(handler(event, 'snapshot'), { previewed: false });
  assert.throws(() => handler(event, 'reset'), /仍在进行/);
  let prevented = false;
  listeners['before-quit']({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(quits, 0);
  completePreview(); await Promise.resolve(); await Promise.resolve();
  // Response (including timeout) must arrive before the external idle promise.
  const received = await response;
  if (!responseFailure) assert.deepEqual(received, { previewed: true });
  assert.throws(() => handler(event, 'reset'), /仍在进行/);
  assert.equal(quits, 0);
  if (confirmedIdle) {
    markIdle(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(quits, 1);
  } else {
    rejectIdle(new Error('termination unknown')); await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => handler(event, 'reset'), /仍在进行/);
    assert.deepEqual(handler(event, 'snapshot'), { previewed: true });
    assert.equal(quits, 0);
  }
  assert.equal(resets, 0);
});
