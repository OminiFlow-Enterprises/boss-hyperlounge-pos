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
  waiterName?: string;
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
    items: payload.items,
    printTime: clockTime(printedAt),
    operatorName: payload.operatorName ?? "",
    waiterName: payload.waiter?.trim(),
    remark: payload.remark?.trim(),
  });
}

export function renderKotTicket(ticket: KotTicket): string {
  const rows = ticket.items.map(({ name, qty }) =>
    `<div class="item${qty < 0 ? " cancelled" : ""}"><span>${esc(name.toUpperCase())}</span><span class="qty">${qty.toFixed(2)}</span></div>`,
  ).join("\n");
  const dateTime = ticket.time ? `${ticket.date}   ${ticket.time}` : ticket.date;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>KOT ${esc(ticket.kotNo)}</title>
<style>
  @page { size: auto; margin: 0; }
  html { background: #fff; }
  body {
    display: flow-root;
    box-sizing: border-box;
    width: 72mm;
    margin: 0 auto;
    padding: 0 2mm;
    color: #000;
    background: #fff;
    font: 400 9pt/1.25 Arial, Helvetica, sans-serif;
    -webkit-font-smoothing: none;
  }
  h1 { margin: 0 0 2px; text-align: center; font-size: 10.5pt; font-weight: 800; }
  .subtitle { margin: 0 0 4px; text-align: center; }
  .meta {
    display: grid;
    grid-template-columns: 22mm minmax(0, 1fr);
    row-gap: 2px;
    margin: 0;
    font-weight: 400;
  }
  .meta dt { white-space: nowrap; }
  .meta dd { margin: 0; overflow-wrap: anywhere; display: flex; }
  .meta dd::before { content: ":"; }
  .date { white-space: pre; }
  .order { margin: 6px 0; text-align: center; }
  .order div {
    font-size: 10pt;
    font-weight: 800;
    text-decoration: underline;
    text-decoration-thickness: 1.5px;
    text-underline-offset: 2px;
  }
  .head, .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    column-gap: 2mm;
    break-inside: avoid;
  }
  .head { border-bottom: 1px solid #000; }
  .item { font-weight: 600; overflow-wrap: anywhere; }
  .items { border-bottom: 1px dashed #000; }
  .cancelled span { text-decoration: line-through; text-decoration-thickness: 2px; }
  .qty { text-align: right; white-space: nowrap; }
  .waiter, .remark { margin: 2px 0 0; overflow-wrap: anywhere; }
  footer { padding-bottom: 6mm; break-inside: avoid; }
  .end { margin: 6px 0; text-align: center; }
  .operator { display: flex; justify-content: space-between; gap: 2mm; font-size: 7.5pt; }
  .operator span:last-child { text-align: right; overflow-wrap: anywhere; }
</style>
</head>
<body>
  <h1>${esc(ticket.department)}</h1>
  <p class="subtitle">Restaurant KOT</p>
  <dl class="meta">
    <dt>KOT No.</dt><dd><span>${esc(ticket.kotNo)}</span></dd>
    <dt>Table No.</dt><dd><span>${esc(ticket.tableNo)}</span></dd>
    <dt>Date</dt><dd><span class="date">${esc(dateTime)}</span></dd>
    <dt>Stward</dt><dd><span>${esc(ticket.steward)}</span></dd>
  </dl>
  <div class="order"><div>${esc(ticket.orderType)}</div><div>${esc(ticket.copyType)}</div></div>
  <div class="head"><span>Item Name</span><span class="qty">Qty</span></div>
  <div class="items">${rows}</div>
  ${ticket.waiterName ? `<p class="waiter">${esc(ticket.waiterName.toUpperCase())}</p>` : ""}
  ${ticket.remark ? `<p class="remark">${esc(ticket.remark)}</p>` : ""}
  <footer>
    <p class="end">--- END ---</p>
    <div class="operator"><time>${esc(ticket.printTime)}</time><span>${esc(ticket.operatorName.toUpperCase())}</span></div>
  </footer>
</body>
</html>`;
}
