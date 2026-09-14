import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { startOfflineDemo } from "../desktop/demoRuntime.cjs";
import { createOfflineStoreDemo } from "../src/demo/offlineStoreDemo.js";

test("demo boot isolates paths before readiness and denies external requests and foreign IPC", async (t) => {
  const events = [];
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
  }
  const result = await startOfflineDemo({
    app: { getPath: name => { assert.equal(name, 'appData'); return path.resolve('output/test-app-data'); }, setName() {}, setPath: (name) => events.push(name), commandLine: { appendSwitch() {} }, whenReady: async () => events.push("ready"), on() {}, quit() {} },
    BrowserWindow: Window,
    ipcMain: { handle: (_name, fn) => { handler = fn; }, removeHandler() {} },
    session: { fromPartition: (name, options) => { assert.ok(!name.startsWith("persist:")); assert.equal(options.cache, false); return isolatedSession; } }
  }, ({ dataDir }) => {
    assert.equal(dataDir, path.resolve('output/test-app-data/opspilot-open-core/offline-demo'));
    return createOfflineStoreDemo();
  });
  t.after(() => fs.rm(result.cache, { recursive: true, force: true }));
  assert.deepEqual(events, ["userData", "sessionData", "ready"]);
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
});
