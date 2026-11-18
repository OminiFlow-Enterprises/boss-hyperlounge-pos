const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bossPrint", {
  printHtml: (html, deviceName = "bill") =>
    ipcRenderer.invoke("pos:print-html", { html, deviceName: deviceName || "bill" }),
});

contextBridge.exposeInMainWorld("bossWindow", {
  minimize: () => ipcRenderer.invoke("pos:window", "minimize"),
  maximize: () => ipcRenderer.invoke("pos:window", "maximize"),
  close: () => ipcRenderer.invoke("pos:window", "close"),
});
