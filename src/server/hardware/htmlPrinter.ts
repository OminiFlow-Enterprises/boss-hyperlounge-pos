import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function projectRoot(): string {
  // dist/server/hardware -> repo root; src/server/hardware -> repo root
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

function electronBinary(): string | null {
  // Packaged / desktop: server is often started with Electron as Node.
  if (process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
    return process.execPath;
  }
  try {
    const bin = require("electron");
    return typeof bin === "string" ? bin : null;
  } catch {
    return null;
  }
}

/**
 * Silent-print HTML to a Windows queue (default `bill`) via Electron.
 */
export async function printHtmlToQueue(
  html: string,
  deviceName = "bill",
  layout: "bill" | "kot" = "bill",
): Promise<{ ok: boolean; error?: string }> {
  const root = projectRoot();
  const printer = deviceName.trim() || "bill";
  const script = path.join(root, "electron", "print-html-file.cjs");
  if (!fs.existsSync(script)) {
    return { ok: false, error: `Missing print helper: ${script}` };
  }
  const electronPath = electronBinary();
  if (!electronPath) {
    return { ok: false, error: "Electron not installed — cannot silent-print HTML" };
  }

  const tmp = path.join(os.tmpdir(), `boss-${layout}-${Date.now()}-${Math.random().toString(16).slice(2)}.html`);
  try {
    fs.writeFileSync(tmp, html, "utf8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve) => {
    const child = spawn(electronPath, [script, tmp, printer, layout], {
      cwd: root,
      env: { ...env, POS_PRINT_HTML: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (b) => {
      out += b.toString();
    });
    child.stderr?.on("data", (b) => {
      out += b.toString();
    });
    child.on("error", (err) => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: err.message });
    });
    child.on("exit", (code) => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: out.trim() || `print exit ${code}` });
    });
  });
}
