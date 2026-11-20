import { spawn, execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".cache");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const windowsNpx = process.platform === "win32" && command === "npx";
    const executable = windowsNpx ? process.execPath : command;
    const executableArgs = windowsNpx
      ? [path.join(root, "node_modules/electron-builder/cli.js"), ...args.slice(1)]
      : args;
    const child = spawn(executable, executableArgs, {
      cwd: root,
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

function electronBin() {
  if (process.platform === "win32") {
    return path.join(root, "node_modules/electron/dist/electron.exe");
  }
  if (process.platform === "darwin") {
    return path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  }
  return path.join(root, "node_modules/electron/dist/electron");
}

async function electronAbi() {
  const { stdout } = await exec(electronBin(), ["-p", "process.versions.modules"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  return stdout.trim();
}

async function windowsSqlite() {
  const sqlitePkg = JSON.parse(await readFile(path.join(root, "node_modules/better-sqlite3/package.json"), "utf8"));
  const abi = await electronAbi();
  const name = `better-sqlite3-v${sqlitePkg.version}-electron-v${abi}-win32-x64.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqlitePkg.version}/${name}`;
  const dir = path.join(cache, "sqlite-win");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const tarPath = path.join(dir, name);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url} (${response.status})`);
  await pipeline(response.body, createWriteStream(tarPath));
  await exec("tar", ["-xzf", tarPath, "-C", dir]);
  const nodeFile = path.join(dir, "build", "Release", "better_sqlite3.node");
  const buf = await readFile(nodeFile);
  const pe = buf.readUInt32LE(0x3c);
  const machine = buf.readUInt16LE(pe + 4);
  if (buf.readUInt16LE(0) !== 0x5a4d || machine !== 0x8664) {
    throw new Error("Downloaded better_sqlite3.node is not a Windows x64 binary");
  }
  const dest = path.join(
    root,
    "release/win-unpacked/resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  );
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(nodeFile, dest);
  console.log(`Installed Windows better_sqlite3.node (Electron ABI ${abi})`);
}

await run(
  "npx",
  ["electron-builder", "--win", "--x64", "--dir", `-c.electronDownload.cache=${path.join(cache, "electron")}`],
  {
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_BUILDER_CACHE: path.join(cache, "electron-builder"),
    },
  },
);
await windowsSqlite();
await run(
  "npx",
  ["electron-builder", "--win", "nsis", "--x64", "--prepackaged", path.join(root, "release/win-unpacked")],
  {
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_BUILDER_CACHE: path.join(cache, "electron-builder"),
    },
  },
);
