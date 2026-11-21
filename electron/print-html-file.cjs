/**
 * One-shot: electron electron/print-html-file.cjs <htmlPath> [printerName] [bill|kot]
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const [htmlPath, queue, layout] = process.env.POS_PRINT_HTML === "1"
  ? process.argv.slice(-3) : process.argv.slice(2);
const deviceName = queue || "bill";

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
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  const paper = layout === "kot"
    ? {
        pageSize: {
          width: 80000,
          height: Math.ceil(
            (await win.webContents.executeJavaScript("document.body.getBoundingClientRect().height") + 1)
              * 25400 / 96,
          ),
        },
      }
    : { preferCSSPageSize: true };
  win.webContents.print(
    {
      silent: true,
      printBackground: true,
      deviceName,
      margins: { marginType: "none" },
      ...paper,
      scaleFactor: 100,
      copies: 1,
    },
    (success, failureReason) => {
      if (success) console.log(`OK printed ${htmlPath} -> ${deviceName}`);
      else console.error(`Print failed: ${failureReason || "unknown"}`);
      app.exit(success ? 0 : 1);
    },
  );
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
