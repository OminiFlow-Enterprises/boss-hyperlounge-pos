import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".cache");
const child = spawn(
  "npx",
  ["electron-builder", "--win", "--x64", `-c.electronDownload.cache=${path.join(cache, "electron")}`],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_BUILDER_CACHE: path.join(cache, "electron-builder"),
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
