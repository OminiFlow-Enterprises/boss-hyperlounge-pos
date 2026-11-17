/**
 * One-shot: electron electron/print-html-file.cjs <htmlPath> [printerName]
 * Silent-prints an HTML bill to the Windows queue (default: bill).
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const htmlPath = process.argv[2];
const deviceName = process.argv[3] || "bill";

if (!htmlPath || !fs.existsSync(htmlPath)) {
  console.error("Usage: electron electron/print-html-file.cjs <file.html> [printer]");
  process.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 900,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(path.resolve(htmlPath));
  await new Promise((r) => setTimeout(r, 500));
  win.webContents.print(
    {
      silent: true,
      printBackground: true,
      deviceName,
      margins: { marginType: "none" },
      preferCSSPageSize: true,
      scaleFactor: 100,
      copies: 1,
    },
    (success, failureReason) => {
      if (success) console.log(`OK printed ${htmlPath} -> ${deviceName}`);
      else console.error(`Print failed: ${failureReason || "unknown"}`);
      app.exit(success ? 0 : 1);
    },
  );
});
