if (process.env.POS_PRINT_HTML === "1") {
  require("./print-html-file.cjs");
  return;
}

const { app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain, powerSaveBlocker } = require("electron");
const { spawn, execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const { printOfficeSlip } = require("./print-office-slip.cjs");
const packageMetadata = require("../package.json");
const clientOnly = packageMetadata.posClientOnly === true;

const POS_KEYS = new Set(["F1", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);

let server;
let mainWindow;
let logFile;

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { if (logFile) fs.appendFileSync(logFile, line); } catch {}
  process.stderr.write(line);
}

process.on("uncaughtException", (err) => log(`MAIN uncaughtException: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => log(`MAIN unhandledRejection: ${err?.stack || err}`));

const devInstance = process.env.POS_DEV_INSTANCE === "1";
const gotLock = devInstance || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function projectRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
}

function dataDir() {
  if (!app.isPackaged) return path.join(projectRoot(), "data");
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "hyperlounge.sqlite");
  const bundled = path.join(process.resourcesPath, "data", "hyperlounge.sqlite");
  if (!fs.existsSync(dest)) {
    if (["-wal", "-shm", "-journal"].some((suffix) => fs.existsSync(dest + suffix))) {
      throw new Error(`The POS database is missing but recovery files exist in ${dir}. Restore the database before starting.`);
    }
    if (fs.existsSync(bundled)) fs.copyFileSync(bundled, dest, fs.constants.COPYFILE_EXCL);
  }
  return dir;
}

function freePort(start) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(freePort(start + 1)));
    probe.listen(start, "0.0.0.0", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(port, dbDir) {
  const root = projectRoot();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    POS_DATA_DIR: dbDir,
    POS_CLIENT_DIR: path.join(root, "dist", "client"),
    ...(packageMetadata.posExistingDbOnly === true ? { POS_EXISTING_DB_ONLY: "1" } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Always run the API under Electron's Node so better-sqlite3 matches Electron ABI
  // (system node.exe may be a different NODE_MODULE_VERSION).
  const entry = app.isPackaged || fs.existsSync(path.join(root, "dist", "server", "index.js"))
    ? path.join(root, "dist", "server", "index.js")
    : path.join(root, "src", "server", "index.ts");
  const args = entry.endsWith(".ts")
    ? ["--import", "tsx", entry]
    : [entry];
  return spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });
}

function waitForServer(port, child) {
  return new Promise((resolve, reject) => {
    let serverOutput = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    const take = (buf) => {
      serverOutput = (serverOutput + buf.toString()).slice(-4000);
      log(`SERVER ${buf.toString().trimEnd()}`);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.once("exit", (code) => {
      if (!settled) finish(new Error(serverOutput || `POS server exited (${code ?? "signal"})`));
    });
    const deadline = Date.now() + 60000;
    const tick = () => {
      if (settled) return;
      const req = http.get(`http://127.0.0.1:${port}/api/session`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) finish();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => req.destroy());
    };
    const retry = () => {
      if (settled) return;
      if (Date.now() > deadline) finish(new Error(serverOutput || "POS server did not start"));
      else setTimeout(tick, 250);
    };
    tick();
  });
}

const ALT_DIGIT = { Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4" };

function altDigit(input) {
  if (!input.alt || input.control || input.meta) return "";
  if (input.alt && (input.code === "F4" || input.key === "F4")) return "";
  if (ALT_DIGIT[input.code]) return ALT_DIGIT[input.code];
  return ["1", "2", "3", "4"].includes(input.key) ? input.key : "";
}

function deptArrow(input) {
  if (!input.control || input.alt || input.meta) return "";
  if (input.code === "ArrowLeft" || input.key === "ArrowLeft") return "ArrowLeft";
  if (input.code === "ArrowRight" || input.key === "ArrowRight") return "ArrowRight";
  return "";
}

function isPosShortcut(input) {
  if (input.alt && (input.code === "F4" || input.key === "F4")) return false;
  if (POS_KEYS.has(input.code) || POS_KEYS.has(input.key)) return true;
  if (deptArrow(input)) return true;
  return Boolean(altDigit(input));
}

function modifiersOf(input) {
  const list = [];
  if (input.shift) list.push("shift");
  if (input.control) list.push("control");
  if (input.alt) list.push("alt");
  if (input.meta) list.push("meta");
  return list;
}

function stepDeptFromShell(dir) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents
    .executeJavaScript(`window.__bossStepDept && window.__bossStepDept(${dir})`)
    .catch(() => {});
}

const SPACE_SHORTCUTS = ["79", "80", "81", "82"];
let savedSpaceShortcuts = null;

function symbolPlist() {
  return path.join(app.getPath("home"), "Library/Preferences/com.apple.symbolichotkeys.plist");
}

function readSpaceShortcuts() {
  const plist = symbolPlist();
  const saved = {};
  for (const id of SPACE_SHORTCUTS) {
    try {
      const raw = execFileSync("plutil", ["-extract", `AppleSymbolicHotKeys.${id}.enabled`, "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
      saved[id] = raw === "true";
    } catch {
      saved[id] = null;
    }
  }
  return saved;
}

function writeSpaceShortcut(id, enabled) {
  execFileSync("plutil", ["-replace", `AppleSymbolicHotKeys.${id}.enabled`, "-bool", enabled ? "true" : "false", symbolPlist()], { stdio: "ignore" });
}

function publishSpaceShortcuts() {
  execFileSync("python3", ["-c", `
import ctypes
lib = ctypes.CDLL("/usr/lib/libnotify.dylib")
for name in (b"com.apple.HIToolbox.SymbolicHotKeysChanged", b"AppleSymbolicHotKeysChanged"):
    lib.notify_post(name)
`], { stdio: "ignore" });
}

function holdSpaceShortcuts() {
  if (process.platform !== "darwin") return;
  try {
    if (!savedSpaceShortcuts) savedSpaceShortcuts = readSpaceShortcuts();
    for (const id of SPACE_SHORTCUTS) writeSpaceShortcut(id, false);
    publishSpaceShortcuts();
  } catch {}
}

function releaseSpaceShortcuts() {
  if (process.platform !== "darwin" || !savedSpaceShortcuts) return;
  try {
    for (const id of SPACE_SHORTCUTS) {
      const enabled = savedSpaceShortcuts[id];
      if (enabled === null) continue;
      writeSpaceShortcut(id, enabled);
    }
    publishSpaceShortcuts();
  } catch {}
}

function plutilAsync(args) {
  return new Promise((resolve) => {
    execFile("plutil", args, { stdio: "ignore" }, () => resolve());
  });
}

let spaceJob = Promise.resolve();

function readShortcutEnabled(id) {
  return new Promise((resolve) => {
    execFile("plutil", ["-extract", `AppleSymbolicHotKeys.${id}.enabled`, "raw", "-o", "-", symbolPlist()], { encoding: "utf8" }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() === "true");
    });
  });
}

function publishSpaceShortcutsAsync() {
  return new Promise((resolve) => {
    execFile("python3", ["-c", `
import ctypes
lib = ctypes.CDLL("/usr/lib/libnotify.dylib")
for name in (b"com.apple.HIToolbox.SymbolicHotKeysChanged", b"AppleSymbolicHotKeysChanged"):
    lib.notify_post(name)
`], { stdio: "ignore" }, () => resolve());
  });
}

function holdSpaceShortcutsAsync() {
  if (process.platform !== "darwin") return;
  spaceJob = spaceJob.then(async () => {
    try {
      if (!savedSpaceShortcuts) {
        const saved = {};
        for (const id of SPACE_SHORTCUTS) saved[id] = await readShortcutEnabled(id);
        savedSpaceShortcuts = saved;
      }
      const plist = symbolPlist();
      await Promise.all(SPACE_SHORTCUTS.map((id) => plutilAsync(["-replace", `AppleSymbolicHotKeys.${id}.enabled`, "-bool", "false", plist])));
      await publishSpaceShortcutsAsync();
    } catch {}
  });
}

function releaseSpaceShortcutsAsync() {
  if (process.platform !== "darwin" || !savedSpaceShortcuts) return;
  const saved = savedSpaceShortcuts;
  spaceJob = spaceJob.then(async () => {
    try {
      const plist = symbolPlist();
      await Promise.all(SPACE_SHORTCUTS.map((id) => {
        const enabled = saved[id];
        if (enabled === null) return Promise.resolve();
        return plutilAsync(["-replace", `AppleSymbolicHotKeys.${id}.enabled`, "-bool", enabled ? "true" : "false", plist]);
      }));
      await publishSpaceShortcutsAsync();
    } catch {}
  });
}

function registerDeptKeys() {
  holdSpaceShortcutsAsync();
  globalShortcut.register("Control+Left", () => stepDeptFromShell(-1));
  globalShortcut.register("Control+Right", () => stepDeptFromShell(1));
  globalShortcut.register("Control+Shift+Left", () => stepDeptFromShell(-1));
  globalShortcut.register("Control+Shift+Right", () => stepDeptFromShell(1));
}

function unregisterDeptKeys() {
  globalShortcut.unregister("Control+Left");
  globalShortcut.unregister("Control+Right");
  globalShortcut.unregister("Control+Shift+Left");
  globalShortcut.unregister("Control+Shift+Right");
  releaseSpaceShortcutsAsync();
}

function attachShortcuts(win) {
  let passNext = 0;
  win.webContents.on("before-input-event", (event, input) => {
    if (passNext > 0) {
      passNext -= 1;
      return;
    }
    const bareAlt = input.key === "Alt" && !input.control && !input.meta && !input.shift;
    if (bareAlt) {
      event.preventDefault();
      return;
    }
    if (input.type !== "keyDown" && input.type !== "keyUp") return;
    if (!isPosShortcut(input)) return;
    event.preventDefault();
    if (input.type !== "keyDown") return;
    const arrow = deptArrow(input);
    if (arrow) {
      stepDeptFromShell(arrow === "ArrowRight" ? 1 : -1);
      return;
    }
    const digit = altDigit(input);
    if (digit) {
      const key = JSON.stringify(digit);
      win.webContents
        .executeJavaScript(
          `window.dispatchEvent(new KeyboardEvent("keydown",{key:${key},code:"Digit"+${key},altKey:true,bubbles:true,cancelable:true}))`,
        )
        .catch(() => {});
      return;
    }
    const keyCode = POS_KEYS.has(input.code) ? input.code : input.key;
    const modifiers = modifiersOf(input);
    passNext += 2;
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  });
}

function parseServerAddress(value) {
  const address = value.trim();
  if (!address) throw new Error("Enter the POS server IP address.");
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(address);
  const url = new URL(hasScheme ? address : `http://${address}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use a server IP address or an HTTP or HTTPS address without credentials.");
  }
  const authority = address.split(/[/?#]/, 1)[0];
  if (!hasScheme && !/:\d+$/.test(authority)) url.port = "8787";
  return url;
}

function askForServerAddress(previousAddress) {
  const setup = new BrowserWindow({
    width: 465, height: 255, resizable: false, autoHideMenuBar: true,
    title: "THE BOSS POS Client Setup",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const form = `<!doctype html><html lang="en"><meta charset="utf-8"><title>THE BOSS POS Client Setup</title>
    <style>
      body{font:15px 'Segoe UI',sans-serif;margin:25px;color:#18202b;background:#f6f7f9}
      label{display:block;font-weight:600;margin-bottom:8px}input{width:100%;box-sizing:border-box;padding:9px}
      p{min-height:20px;margin:9px 0;color:#5e2222}button{padding:7px 18px}
    </style>
    <form action="https://pos-setup.invalid/connect">
      <label for="address">POS server IP address</label>
      <input id="address" name="address" placeholder="192.168.1.57" required autofocus>
      <p id="error" role="alert"></p>
      <button type="submit">Connect</button>
    </form></html>`;

  return new Promise((resolve, reject) => {
    setup.once("closed", () => resolve(null));
    setup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    setup.webContents.on("will-navigate", (event, target) => {
      event.preventDefault();
      const submission = new URL(target);
      if (submission.origin !== "https://pos-setup.invalid" || submission.pathname !== "/connect") return;
      try {
        const address = parseServerAddress(submission.searchParams.get("address") ?? "");
        resolve(address);
        setup.close();
      } catch {
        void setup.webContents.executeJavaScript(
          'document.getElementById("error").textContent = "Enter a valid server IP or address, such as 192.168.1.57:8787.";'
        ).catch(() => {});
      }
    });
    const initialPage = `data:text/html;charset=utf-8,${encodeURIComponent(form)}`;
    void setup.loadURL(initialPage).then(() => setup.webContents.executeJavaScript(
      `document.getElementById("address").value = ${JSON.stringify(previousAddress)};`
    )).catch(reject);
  });
}

async function openPos() {
  logFile = path.join(app.getPath("userData"), "logs", "pos-debug.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  log(`START packaged=${app.isPackaged} version=${app.getVersion()} appPath=${app.getAppPath()}`);
  Menu.setApplicationMenu(null);
  let posUrl;
  const addressFile = path.join(app.getPath("userData"), "server-address.txt");
  let previousAddress = "";
  if (clientOnly) {
    const serverOption = process.argv.find((arg) => arg.startsWith("--pos-server="));
    const saved = fs.existsSync(addressFile) ? fs.readFileSync(addressFile, "utf8").trim() : "";
    previousAddress = serverOption?.slice("--pos-server=".length) || process.env.POS_SERVER_URL || saved;
    if (previousAddress && !process.argv.includes("--change-server")) {
      try { posUrl = parseServerAddress(previousAddress); } catch { /* Ask for a corrected address. */ }
    }
  } else {
    const port = await freePort(8787);
    server = startServer(port, dataDir());
    await waitForServer(port, server);
    if (app.isPackaged && process.platform === "win32" && !devInstance) {
      try {
        app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
      } catch (error) {
        log(`Could not register Windows sign-in startup: ${error}`);
      }
    }
    posUrl = new URL(`http://127.0.0.1:${port}/`);
  }

  mainWindow = new BrowserWindow({
    icon: process.platform === "win32"
      ? path.join(__dirname, "app-icon.ico")
      : path.join(__dirname, "../dist/client/app-icon.png"),
    width: 1280,
    height: 800,
    show: false,
    title: "THE BOSS",
    backgroundColor: "#f0f0f0",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  attachShortcuts(mainWindow);
  mainWindow.on("focus", registerDeptKeys);
  mainWindow.on("blur", unregisterDeptKeys);
  mainWindow.webContents.on("console-message", (...args) => {
    const values = args.map((value) => {
      try { return JSON.stringify(value); } catch { return String(value); }
    });
    log(`RENDERER console ${values.join(" | ")}`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => log(`RENDERER did-fail-load code=${code} description=${description} url=${url} mainFrame=${isMainFrame}`));
  mainWindow.webContents.on("render-process-gone", (_event, details) => log(`RENDERER process-gone ${JSON.stringify(details)}`));
  mainWindow.webContents.on("unresponsive", () => log("RENDERER unresponsive"));
  mainWindow.webContents.on("did-finish-load", () => log(`RENDERER loaded ${mainWindow.webContents.getURL()}`));
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "Escape") log(`INPUT Escape ${input.type} url=${mainWindow.webContents.getURL()}`);
  });
  mainWindow.webContents.on("dom-ready", () => {
    mainWindow.webContents.executeJavaScript(`
      window.addEventListener('error', e => console.error('[window.error]', e.message, e.filename, e.lineno, e.error?.stack));
      window.addEventListener('unhandledrejection', e => console.error('[unhandledrejection]', e.reason?.stack || e.reason));
    `).catch((err) => log(`RENDERER instrumentation failed: ${err}`));
  });
  if (clientOnly) {
    const blockOtherOrigins = (event, url) => {
      if (new URL(url).origin !== posUrl?.origin) event.preventDefault();
    };
    mainWindow.webContents.on("will-navigate", blockOtherOrigins);
    mainWindow.webContents.on("will-redirect", blockOtherOrigins);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  }
  if (clientOnly) {
    while (true) {
      if (!posUrl) {
        posUrl = await askForServerAddress(previousAddress);
        if (!posUrl) return app.quit();
      }
      try {
        // Revalidate the server's entry page when reopening after an update.
        await mainWindow.loadURL(posUrl.href, { extraHeaders: "Cache-Control: no-cache\n" });
        fs.writeFileSync(addressFile, posUrl.href, "utf8");
        break;
      } catch {
        dialog.showErrorBox("THE BOSS POS Client", `Could not connect to ${posUrl.href}. Check the server IP and try again.`);
        previousAddress = posUrl.href;
        posUrl = undefined;
      }
    }
  } else {
    await mainWindow.loadURL(posUrl.href);
  }
  mainWindow.maximize();
  mainWindow.show();
  mainWindow.focus();
  const sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
  mainWindow.once("closed", () => powerSaveBlocker.stop(sleepBlocker));
  registerDeptKeys();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

ipcMain.handle("pos:window", async (_event, action) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  if (action === "minimize") {
    mainWindow.minimize();
    return { ok: true };
  }
  if (action === "maximize") {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true };
  }
  if (action === "close") {
    mainWindow.close();
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle("pos:export-pdf", async (event, opts) => {
  const landscape = !opts || opts.landscape !== false;
  const pdf = await event.sender.printToPDF({
    printBackground: true,
    landscape,
    pageSize: "A4",
    margins: { marginType: "default" },
  });
  return pdf;
});

ipcMain.handle("pos:print-item-wise-sales", (event) => new Promise((resolve) => {
  event.sender.print({ silent: false, pageSize: "A4" }, (ok, error) => {
    resolve({ ok, error });
  });
}));

ipcMain.handle("pos:print-html", async (_event, { html, deviceName }) => {
  const printer = String(deviceName ?? "bill");
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(String(html || ""))}`);
    await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    const officeIp = process.env.POS_OFFICE_TERMINAL_IP?.trim() || "192.168.1.21";
    const isOfficePc = Object.values(os.networkInterfaces()).flat().some((ip) => ip?.address === officeIp);
    const windowsBillQueue = process.platform === "win32" && printer.toLowerCase() === "bill";
    const sharpBill = windowsBillQueue && packageMetadata.posSharpBillPrint === true &&
      await win.webContents.executeJavaScript('Boolean(document.querySelector(".slip"))');
    const connectedKot = process.platform === "win32" && printer === "" &&
      await win.webContents.executeJavaScript('document.title.startsWith("KOT ")');
    if (connectedKot || (windowsBillQueue && (sharpBill || isOfficePc))) {
      await printOfficeSlip(win, printer, {
        sharpBill: sharpBill || connectedKot,
        rejectBlank: connectedKot,
        preferredQueue: connectedKot && isOfficePc ? "bill" : "",
      });
      return { ok: true };
    }
    const result = await new Promise((resolve) => {
      win.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: printer,
          margins: { marginType: "none" },
          preferCSSPageSize: true,
          scaleFactor: 100,
          pagesPerSheet: 1,
          collate: false,
          copies: 1,
        },
        (success, failureReason) => {
          resolve({ ok: Boolean(success), error: success ? undefined : failureReason || "print failed" });
        },
      );
    });
    return result;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

app.whenReady().then(async () => {
  if (gotLock && process.platform === "win32" && app.isPackaged && !clientOnly) {
    try {
      app.setLoginItemSettings({ openAtLogin: true });
    } catch (error) {
      log(`Windows auto-start: ${error.message}`);
    }
  }
  await openPos();
}).catch((error) => {
  dialog.showErrorBox("THE BOSS POS", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (server && !server.killed) server.kill();
  app.quit();
});

app.on("before-quit", () => {
  globalShortcut.unregister("Control+Left");
  globalShortcut.unregister("Control+Right");
  globalShortcut.unregister("Control+Shift+Left");
  globalShortcut.unregister("Control+Shift+Right");
  releaseSpaceShortcuts();
  if (server && !server.killed) server.kill();
});
