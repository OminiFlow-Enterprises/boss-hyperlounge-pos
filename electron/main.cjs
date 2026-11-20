const { app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain } = require("electron");
const { spawn, execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

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
  if (!fs.existsSync(dest) && fs.existsSync(bundled)) fs.copyFileSync(bundled, dest);
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
    let log = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    const take = (buf) => {
      log = (log + buf.toString()).slice(-4000);
      log(`SERVER ${buf.toString().trimEnd()}`);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.once("exit", (code) => {
      if (!settled) finish(new Error(log || `POS server exited (${code ?? "signal"})`));
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
      if (Date.now() > deadline) finish(new Error(log || "POS server did not start"));
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

async function openPos() {
  logFile = path.join(app.getPath("userData"), "logs", "pos-debug.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  log(`START packaged=${app.isPackaged} version=${app.getVersion()} appPath=${app.getAppPath()}`);
  Menu.setApplicationMenu(null);
  const port = await freePort(8787);
  const dbDir = dataDir();
  server = startServer(port, dbDir);
  try {
    await waitForServer(port, server);
  } catch (err) {
    dialog.showErrorBox("THE BOSS POS", err instanceof Error ? err.message : "POS server did not start");
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
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
  mainWindow.webContents.on("console-message", (_event, details) => log(`RENDERER console ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`));
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
  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
    registerDeptKeys();
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
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

ipcMain.handle("pos:print-html", async (_event, { html, deviceName }) => {
  const printer = String(deviceName || "bill");
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: true,
    },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(String(html || ""))}`);
    await new Promise((r) => setTimeout(r, 400));
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

app.whenReady().then(openPos);

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
