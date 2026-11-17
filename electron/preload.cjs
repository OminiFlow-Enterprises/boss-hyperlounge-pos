const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bossPrint", {
  printHtml: (html, deviceName = "bill") =>
    ipcRenderer.invoke("pos:print-html", { html, deviceName: deviceName || "bill" }),
});
