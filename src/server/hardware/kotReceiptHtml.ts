import type { KotPrintPayload } from "./types.js";
import { KOT_COLS } from "./escpos.js";

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatKotDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const day = when.getDate();
  const mon = when.toLocaleString("en-GB", { month: "short" });
  const year = when.getFullYear();
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  const ss = String(when.getSeconds()).padStart(2, "0");
  return `${day} ${mon} ${year}  ${hh}:${mm}:${ss}`;
}

function padField(label: string, value: string): string {
  const head = label.length >= 10 ? `${label}:` : `${label}${" ".repeat(10 - label.length)}:`;
  return `${head} ${value}`;
}

/** HTML preview of KOT — cancel/minus rows use strikethrough like native IBS. */
export function formatKotHtml(payload: KotPrintPayload): string {
  const kotNo = String(payload.kotNumber).replace(/\D/g, "") || payload.kotNumber;
  const station = payload.station === "BAR" ? "BAR" : "KITCHEN";
  const banner = payload.orderBanner === "NEW ORDER" ? "NEW ORDER" : "RUNNING ORDER";
  const copy = payload.reprint ? "Reprint Copy" : "Original Copy";
  const remark = String(payload.remark ?? "").trim();

  const itemRows = payload.items
    .map((it) => {
      const cancel = it.qty < 0;
      const qty = String(it.qty);
      const name = esc(it.name.toUpperCase());
      const cls = cancel ? "item cancel" : "item";
      return `<div class="${cls}"><span class="n">${name}</span><span class="bar">|</span><span class="q">${esc(qty)}</span></div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>KOT ${esc(kotNo)} preview</title>
<style>
  html, body { margin: 0; background: #777; font-family: "Consolas", "Courier New", monospace; }
  .slip {
    width: ${KOT_COLS}ch;
    margin: 24px auto;
    padding: 16px 14px 28px;
    background: #fff;
    color: #111;
    font-size: 13px;
    line-height: 1.25;
    white-space: pre;
    box-shadow: 0 8px 24px rgba(0,0,0,.35);
  }
  .c { text-align: center; white-space: normal; }
  .title { font-size: 28px; font-weight: 900; letter-spacing: 1px; }
  .sub { font-weight: 800; margin-bottom: 8px; }
  .meta { font-weight: 700; }
  .banner { text-align: center; font-weight: 900; text-decoration: underline; text-underline-offset: 2px; }
  .copy { text-align: center; font-weight: 700; margin-bottom: 6px; }
  .rule { border-top: 3px solid #111; margin: 4px 0; }
  .head, .item {
    display: grid;
    grid-template-columns: 1fr 1ch 3ch;
    font-weight: 700;
    white-space: normal;
  }
  .head { font-weight: 900; }
  .q { text-align: right; }
  .item.cancel {
    position: relative;
    text-decoration: line-through;
    text-decoration-thickness: 2px;
  }
  .item.cancel::after {
    content: "";
    position: absolute;
    left: 0; right: 0;
    top: 50%;
    border-top: 2px solid #111;
    transform: translateY(-50%);
    pointer-events: none;
  }
  .hint {
    margin: 12px auto 0;
    width: ${KOT_COLS}ch;
    color: #eee;
    font: 12px/1.4 Tahoma, sans-serif;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="slip">
    <div class="c title">${esc(station)}</div>
    <div class="c sub">Restaurant KOT</div>
    <div class="meta">${esc(padField("KOT No.", kotNo))}</div>
    <div class="meta">${esc(padField("Table No.", payload.tableCode))}</div>
    <div class="meta">${esc(padField("Date", formatKotDate(payload.createdAt)))}</div>
    <div class="meta">${esc(padField("Stward", payload.waiter?.trim() || ""))}</div>
    <br/>
    <div class="banner">${esc(banner)}</div>
    <div class="copy">${esc(copy)}</div>
    <div class="rule"></div>
    <div class="head"><span>Item Name</span><span>|</span><span class="q">Qty</span></div>
    <div class="rule"></div>
    ${itemRows}
    <div class="rule"></div>
    ${remark ? `<div class="meta">${esc(remark)}</div>` : ""}
  </div>
  <div class="hint">KOT HTML preview — cancel/minus rows must show a straight strike through the item.</div>
</body>
</html>`;
}
