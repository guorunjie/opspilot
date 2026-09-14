const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

// Separate Electron entry: never import main.cjs, production preload, server,
// config loaders or platform adapters. A fresh cache is not a real store profile.
async function startOfflineDemo({ app, BrowserWindow, ipcMain, session, dialog }, createDemo) {
  const dataDir = path.join(app.getPath('appData'), 'opspilot-open-core', 'offline-demo');
  app.setName("OpsPilot 离线演示");
  // Stable Core-only identity: a random userData path would give each launch
  // an independent instance lock despite sharing the same business database.
  const runtimeDir = path.join(app.getPath('appData'), 'opspilot-open-core', 'desktop-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  app.setPath("userData", runtimeDir);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { secondary: true };
  }
  let window = null;
  app.on('second-instance', () => {
    // Never interpret another launch's arguments as commands or approval.
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    }
  });
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "opspilot-offline-demo-"));
  app.setPath("sessionData", cache);
  app.commandLine.appendSwitch("disable-background-networking");
  await app.whenReady();
  const isolatedSession = session.fromPartition(`opspilot-demo-${randomUUID()}`, { cache: false });
  const files = ["index.html", "demo.js", "demo.css"].map((name) => pathToFileURL(path.join(__dirname, "demo", name)).href);
  isolatedSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !files.includes(details.url) }));
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  const demo = await createDemo({ dataDir });
  window = new BrowserWindow({
    width: 1100, height: 800, minWidth: 760, minHeight: 600,
    title: "OpsPilot · 离线演示（合成数据）",
    webPreferences: {
      session: isolatedSession, preload: path.join(__dirname, "demo-preload.cjs"),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const commands = {
    snapshot: () => demo.snapshot(), diagnose: () => demo.diagnose(),
    preview: async () => { await demo.preview(); return demo.snapshot(); },
    confirm: (input) => demo.confirm(input), execute: (input) => demo.execute(input),
    readback: () => demo.readback(), reset: input => demo.reset(input),
    opportunity: input => demo.opportunity(input),
    upgrade: async () => {
      const eligibility = demo.snapshot().legacyUpgrade;
      if (typeof demo.upgrade !== 'function' || eligibility?.available !== true)
        throw new Error('当前没有可升级的旧版演示记录。');
      const answer = await dialog.showMessageBox(window, { type: 'warning',
        buttons: ['取消', '保留旧记录并开始新版演示'], defaultId: 0, cancelId: 0,
        title: '确认切换演示版本', message: '旧记录将保留为只读存档，不会继续执行。',
        detail: '旧任务的状态、确认和回读证据保持原样，可在页面查看。新版使用独立模拟任务，需要重新诊断、预览和确认。未完成的旧任务不会被标记为成功。此操作不影响真实门店。' });
      if (answer.response !== 1) return demo.snapshot();
      return demo.upgrade({ confirmed: true, expectedRevision: eligibility.revision });
    },
    recover: async () => {
      if (typeof demo.recover !== 'function' || demo.snapshot().recovery?.canRecover !== true)
        throw new Error('当前记录无法安全恢复，请保留记录。');
      const answer = await dialog.showMessageBox(window, { type: 'warning',
        buttons: ['取消', '恢复待核实记录'], defaultId: 0, cancelId: 0,
        title: '确认恢复离线演示',
        message: '恢复仅处理已停止的本机模拟任务，不会重新提交。',
        detail: '中断任务将标记为结果未知。恢复后请点击“核对模拟平台结果”，取得回读证据后再判断结果。不会影响真实门店。' });
      // Never accept renderer-supplied termination proof or confirmation.
      // Recheck ownership and process presence after the native dialog closes.
      if (answer.response !== 1) return demo.snapshot();
      return demo.recover({ confirmed: true });
    }
  };
  let pending = null, quitRequested = false;
  ipcMain.handle("opspilot-demo:command", (event, command, input) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !Object.hasOwn(commands, command)) {
      throw new Error("演示请求被拒绝。");
    }
    if (command === 'snapshot') return commands.snapshot();
    if (pending || quitRequested) throw new Error('操作仍在进行，请等待完成后再继续。');
    // Fence in the trusted main process, not only the renderer's disabled UI.
    // Do not queue stale confirmations or resets behind an outstanding write.
    const operation = Promise.resolve().then(() => commands[command](input));
    const drain = async () => {
      // An async Agent may report timeout before the underlying work stops.
      // Such adapters must expose whenIdle; never turn a timeout into idle.
      if (typeof demo.whenIdle === 'function') await demo.whenIdle();
    };
    pending = operation.then(drain, drain);
    pending.then(() => {
      pending = null;
      if (quitRequested) app.quit();
    }, () => {
      // If external termination is unconfirmed, retain the fence. The user
      // can still inspect a snapshot, but no reset or automatic retry occurs.
      // Deliberately keep pending set; do not hide the original command
      // response while separately waiting for physical termination.
    });
    return operation;
  });
  app.on('before-quit', event => {
    if (pending) { quitRequested = true; event.preventDefault(); }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => ipcMain.removeHandler("opspilot-demo:command"));
  await window.loadFile(path.join(__dirname, "demo", "index.html"));
  return { window, cache };
}

module.exports = { startOfflineDemo };
