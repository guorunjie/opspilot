const electron = require("electron");
const { startOfflineDemo } = require("./demoRuntime.cjs");

// Electron's entry loader need not set require.main to this module.
// Keep the executable entry separate from the importable testable runtime.
startOfflineDemo(electron, async ({ dataDir }) => {
  const { createDesktopDemo } = await import("../src/demo/desktopDemoFactory.js");
  const { openStateStore } = await import('../src/storage/sqliteStateStore.js');
  const { prepareDemoDatabasePath } = await import('../src/storage/demoStoragePath.js');
  const store = openStateStore(prepareDemoDatabasePath(dataDir), 'offline-demo');
  try {
    const demo = createDesktopDemo({ store });
    electron.app.once('will-quit', () => store.close());
    return demo;
  } catch (error) { store.close(); throw error; }
}).catch((error) => {
  console.error("Offline demo startup failed:", error.message);
  electron.dialog.showErrorBox("离线演示启动失败", error.message);
  electron.app.quit();
});
