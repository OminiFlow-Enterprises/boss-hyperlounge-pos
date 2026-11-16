const { app, BrowserWindow, Menu, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const POS_KEYS = new Set(["F1", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);

let server;
let mainWindow;

const gotLock = app.requestSingleInstanceLock();
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
  if (app.isPackaged) {
    return spawn(process.execPath, [path.join(root, "dist", "server", "index.js")], {
      cwd: root,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
    });
  }
  return spawn(process.platform === "win32" ? "node.exe" : "node", ["--import", "tsx", path.join(root, "src", "server", "index.ts")], {
    cwd: root,
    env,
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
      process.stdout.write(buf);
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

function isPosShortcut(input) {
  if (input.alt && (input.code === "F4" || input.key === "F4")) return false;
  if (POS_KEYS.has(input.code) || POS_KEYS.has(input.key)) return true;
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
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  attachShortcuts(mainWindow);
  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(openPos);

app.on("window-all-closed", () => {
  if (server && !server.killed) server.kill();
  app.quit();
});

app.on("before-quit", () => {
  if (server && !server.killed) server.kill();
});
