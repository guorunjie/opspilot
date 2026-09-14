const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("opspilotDemo", {
  command: (command, input) => ipcRenderer.invoke("opspilot-demo:command", command, input)
});
