/**
 * One-shot: electron electron/print-html-file.cjs <htmlPath> [printerName] [bill|kot]
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

const [htmlPath, queue, layout] = process.env.POS_PRINT_HTML === "1"
  ? process.argv.slice(-3) : process.argv.slice(2);
const deviceName = queue || "bill";

if (!htmlPath || !fs.existsSync(htmlPath)) {
  console.error("Usage: electron electron/print-html-file.cjs <file.html> [printer]");
  process.exit(1);
}

async function printWindowsKot(win) {
  const ticket = await win.webContents.executeJavaScript(`(() => {
    const body = document.body;
    return {
      width: Math.ceil(body.getBoundingClientRect().width),
      height: Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height)),
    };
  })()`);
  win.setContentSize(320, ticket.height);
  await win.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))",
  );
  const image = await win.webContents.capturePage({
    x: Math.round((320 - ticket.width) / 2), y: 0, ...ticket,
  });
  if (image.isEmpty()) throw new Error("KOT capture was empty");

  const pngPath = `${htmlPath}.png`;
  try {
    fs.writeFileSync(pngPath, image.toPNG());
    const script = fs.readFileSync(path.join(__dirname, "print-kot-image.ps1"), "utf8");
    await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], {
      timeout: 20_000,
      windowsHide: true,
      env: {
        ...process.env,
        POS_KOT_IMAGE: path.resolve(pngPath),
        POS_KOT_QUEUE: deviceName,
        POS_KOT_HEIGHT_PX: String(ticket.height),
      },
    });
  } finally {
    fs.rmSync(pngPath, { force: true });
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 900,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.resolve(htmlPath));
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  if (layout === "kot" && process.platform === "win32") {
    await printWindowsKot(win);
    app.exit(0);
    return;
  }
  let paper = { preferCSSPageSize: true };
  if (layout === "kot") {
    const contentHeight = await win.webContents.executeJavaScript(`
      Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height)
    `);
    paper = { pageSize: { width: 80000, height: Math.ceil(contentHeight * 25400 / 96) } };
  }
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
