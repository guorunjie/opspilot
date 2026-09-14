const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

// Separate Electron entry: never import main.cjs, production preload, server,
// config loaders or platform adapters. A fresh cache is not a real store profile.
async function startOfflineDemo({ app, BrowserWindow, ipcMain, session }, createDemo) {
  const dataDir = path.join(app.getPath('appData'), 'opspilot-open-core', 'offline-demo');
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "opspilot-offline-demo-"));
  app.setName("OpsPilot 离线演示");
  app.setPath("userData", cache);
  app.setPath("sessionData", cache);
  app.commandLine.appendSwitch("disable-background-networking");
  await app.whenReady();
  const isolatedSession = session.fromPartition(`opspilot-demo-${randomUUID()}`, { cache: false });
  const files = ["index.html", "demo.js", "demo.css"].map((name) => pathToFileURL(path.join(__dirname, "demo", name)).href);
  isolatedSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !files.includes(details.url) }));
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  const demo = await createDemo({ dataDir });
  const window = new BrowserWindow({
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
    readback: () => demo.readback(), reset: () => demo.reset(),
    opportunity: input => demo.opportunity(input)
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
