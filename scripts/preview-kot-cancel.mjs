import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { exec } from "node:child_process";

const root = path.resolve("C:/Users/pc/Documents/GitHub/boss-hyperlounge-pos");
const htmlMod = pathToFileURL(path.join(root, "dist/server/hardware/kotReceiptHtml.js")).href;
const { formatKotHtml } = await import(htmlMod);

const html = formatKotHtml({
  kotNumber: "KOT-10055",
  tableCode: "23",
  waiter: "A",
  station: "KITCHEN",
  reprint: false,
  orderBanner: "RUNNING ORDER",
  remark: "sds",
  createdAt: "2026-11-18T17:57:43+05:30",
  items: [{ name: "AAA", qty: -2 }],
});

const outDir = path.join(root, "scripts/out");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "kot-cancel-preview.html");
fs.writeFileSync(out, html, "utf8");
console.log("wrote", out);
exec(`start "" "${out}"`);
