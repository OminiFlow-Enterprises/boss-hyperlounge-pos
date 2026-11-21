import type { KotPrintPayload } from "./types.js";

interface KotTicket {
  department: KotPrintPayload["station"];
  kotNo: string | number;
  tableNo: string | number;
  date: string;
  time: string;
  steward: string;
  orderType: "NEW ORDER" | "RUNNING ORDER";
  copyType: "Original Copy" | "Duplicate Copy";
  items: KotPrintPayload["items"];
  printTime: string;
  operatorName: string;
  remark?: string | null;
}

function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clockTime(when: Date): string {
  return when.toLocaleTimeString("en-GB", { hourCycle: "h23" });
}

export function formatKotHtml(payload: KotPrintPayload, printedAt = new Date()): string {
  const createdAt = new Date(payload.createdAt);
  const validDate = Number.isFinite(createdAt.getTime());
  return renderKotTicket({
    department: payload.station,
    kotNo: payload.kotNumber.replace(/^KOT-/i, ""),
    tableNo: payload.tableCode,
    date: validDate
      ? createdAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : payload.createdAt,
    time: validDate ? clockTime(createdAt) : "",
    steward: Array.from(payload.waiter?.trim() ?? "")[0]?.toUpperCase() ?? "",
    orderType: payload.orderBanner ?? "RUNNING ORDER",
    copyType: payload.reprint ? "Duplicate Copy" : "Original Copy",
    items: payload.items.map((item) => ({ ...item, name: item.name.toUpperCase() })),
    printTime: clockTime(printedAt),
    operatorName: payload.operatorName ?? "",
    remark: payload.remark?.trim(),
  });
}

export function renderKotTicket(ticket: KotTicket): string {
  const rows = ticket.items.map(({ name, qty }) =>
    `<div class="item${qty < 0 ? " cancelled" : ""}"><span>${esc(name)}</span><span class="qty">${qty.toFixed(2)}</span></div>`,
  ).join("\n");
  const time = ticket.time ? `    <span class="time">${esc(ticket.time)}</span>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>KOT ${esc(ticket.kotNo)}</title>
<style>
  @page { size: auto; margin: 0; }
  html { background: #fff; }
  body {
    box-sizing: border-box;
    width: 72mm;
    margin: 0 auto;
    padding: 2mm;
    color: #000;
    background: #fff;
    font: 500 13pt/1.35 Arial, "Helvetica Neue", Helvetica, sans-serif;
    -webkit-font-smoothing: none;
  }
  h1 { margin: 0 0 2px; text-align: center; font-size: 18pt; font-weight: 800; letter-spacing: 1px; }
  .subtitle { margin: 0 0 10px; text-align: center; font-weight: 400; }
  .meta {
    display: grid;
    grid-template-columns: 17mm minmax(0, 1fr);
    row-gap: 4px;
    margin: 0;
    font-weight: 400;
  }
  .meta dd { margin: 0; overflow-wrap: anywhere; display: flex; }
  .meta dd::before { content: ":"; }
  .date { white-space: pre-wrap; }
  .time { white-space: nowrap; }
  .order { margin: 10px 0 12px; }
  .order div {
    font-size: 14pt;
    font-weight: 800;
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }
  .head, .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    column-gap: 2mm;
    break-inside: avoid;
  }
  .head { font-weight: 400; border-bottom: 1px dashed #000; }
  .item { font-weight: 600; overflow-wrap: anywhere; }
  .items { border-bottom: 1px dashed #000; }
  .cancelled span { text-decoration: line-through; text-decoration-thickness: 2px; }
  .qty { text-align: right; white-space: nowrap; }
  .remark { margin: 4px 0 0; overflow-wrap: anywhere; }
  footer { padding-bottom: 10mm; break-inside: avoid; }
  .end { margin: 14px 0; text-align: center; font-weight: 400; }
  .operator { display: flex; justify-content: space-between; gap: 2mm; font-size: 12pt; font-weight: 400; }
  .operator span:last-child { text-align: right; overflow-wrap: anywhere; }
</style>
</head>
<body>
  <h1>${esc(ticket.department)}</h1>
  <p class="subtitle">Restaurant KOT</p>
  <dl class="meta">
    <dt>KOT No.</dt><dd><span>${esc(ticket.kotNo)}</span></dd>
    <dt>Table No.</dt><dd><span>${esc(ticket.tableNo)}</span></dd>
    <dt>Date</dt><dd><span class="date">${esc(ticket.date)}${time}</span></dd>
    <dt>Stward</dt><dd><span>${esc(ticket.steward)}</span></dd>
  </dl>
  <div class="order"><div>${esc(ticket.orderType)}</div><div>${esc(ticket.copyType)}</div></div>
  <div class="head"><span>Item Name</span><span class="qty">Qty</span></div>
  <div class="items">${rows}</div>
  ${ticket.remark ? `<p class="remark">${esc(ticket.remark)}</p>` : ""}
  <footer>
    <p class="end">--- END ---</p>
    <div class="operator"><time>${esc(ticket.printTime)}</time><span>${esc(ticket.operatorName.toUpperCase())}</span></div>
  </footer>
</body>
</html>`;
}
