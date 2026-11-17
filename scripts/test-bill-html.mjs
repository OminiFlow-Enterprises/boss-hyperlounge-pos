import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { renderBillReceiptHtml } = await import("../src/server/hardware/billReceiptHtml.ts");
const { sampleBillPayload } = await import("../src/server/hardware/escpos.ts");

const html = renderBillReceiptHtml(sampleBillPayload());
const outDir = path.join(root, "scripts", "out");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "sample-bill.html");
fs.writeFileSync(outFile, html, "utf8");
console.log(`Wrote ${outFile} (${html.length} bytes)`);

let electronPath;
try {
  electronPath = require("electron");
} catch {
  electronPath = null;
}
if (!electronPath || typeof electronPath !== "string") {
  console.log("Electron not found — open sample-bill.html in a browser to compare.");
  process.exit(0);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [path.join(root, "electron", "print-html-file.cjs"), outFile, "bill"], {
  cwd: root,
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
