import { amountInWords, stewardInitial } from "./escpos.js";
import { buildBillTotalLines } from "./billTotals.js";
import { BILL_VENUE_DEFAULTS, type BillReceiptPayload } from "./types.js";

/** Default bill print mode. Set POS_BILL_PRINT=escpos to use the old TM-T82 raw template. */
export function billPrintMode(): "html" | "escpos" {
  return process.env.POS_BILL_PRINT === "escpos" ? "escpos" : "html";
}

function money(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(Math.round(paise));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}

function esc(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function billDateParts(iso: string): { date: string; time: string } {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return { date: iso.slice(0, 11), time: "" };
  const day = String(when.getDate()).padStart(2, "0");
  const mon = when.toLocaleString("en-GB", { month: "short" });
  const year = when.getFullYear();
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  const ss = String(when.getSeconds()).padStart(2, "0");
  return { date: `${day} ${mon} ${year}`, time: `${hh}:${mm}:${ss}` };
}

function outletLabel(outlet: string): string {
  const u = outlet.trim().toUpperCase();
  if (u.includes("CLUB")) return "THE BOSS CLUB";
  if (u.includes("RESTAURANT")) return "RESTAURANT";
  if (u === "NC") return "NC";
  if (u.includes("CAFE")) return "CAFE";
  return "BAR";
}

function defaultTotalRows(payload: BillReceiptPayload): Array<{ label: string; base?: string; amount: number }> {
  return buildBillTotalLines({
    lines: payload.items.map((it) => ({
      amount: it.amount,
      taxRate: 0,
      salesGroup: "",
    })),
    discount: payload.discount,
    discountPct: payload.discountPct,
    serviceCharge: payload.serviceCharge,
    serviceChargePct: payload.serviceChargePct,
    otherCharges: payload.otherCharges,
    roundOff: payload.roundOff,
    taxTotal: payload.tax,
  }).map((row) => ({
    label: row.label,
    base: row.base != null ? money(row.base) : undefined,
    amount: row.amount,
  }));
}

const CSS = `
@page { size: 80mm auto; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 80mm;
  max-width: 80mm;
  margin: 0;
  padding: 0;
  background: #fff;
  color: #000;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 11px;
  line-height: 1.3;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.slip {
  width: 72mm;
  max-width: 300px;
  margin: 0 auto;
  padding: 2mm 3mm 5mm;
  color: #000;
  background: #fff;
  overflow: hidden;
}
.center { text-align: center; }
.biz-name {
  font-family: Arial, Helvetica, sans-serif;
  font-size: 26px;
  font-weight: 900;
  line-height: 1.15;
  letter-spacing: 0;
  text-transform: uppercase;
}
.biz-unit {
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
  margin-top: 1px;
  text-transform: uppercase;
}
.biz-line {
  font-size: 11px;
  font-weight: 400;
  line-height: 1.5;
  margin-top: 1px;
}
.outlet {
  font-size: 13px;
  font-weight: 700;
  margin: 8px 0;
  text-transform: uppercase;
}
.meta {
  display: grid;
  grid-template-columns: 60% 40%;
  width: 100%;
  font-size: 11px;
  line-height: 1.35;
  margin-bottom: 4px;
}
.meta-left .row {
  display: grid;
  grid-template-columns: 4.2em auto 1fr;
  align-items: baseline;
  white-space: nowrap;
}
.meta-right .row {
  display: grid;
  grid-template-columns: 2.4em 1fr;
  align-items: baseline;
  white-space: nowrap;
}
.meta .lbl { font-weight: 700; }
.meta .colon { font-weight: 700; padding-right: 0; }
.meta .val { font-weight: 600; min-width: 0; }
.meta-right .lbl { font-weight: 400; padding-right: 0.35em; }
.items {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 11px;
  margin-top: 2px;
}
.items col.c-name { width: 44%; }
.items col.c-rate { width: 20%; }
.items col.c-qty { width: 12%; }
.items col.c-amt { width: 24%; }
.items thead th {
  font-weight: 700;
  font-size: 11px;
  padding: 2px 0;
  border-top: 1px solid #000;
  border-bottom: 1px solid #000;
  line-height: 1.2;
}
.items thead th.n { text-align: left; }
.items thead th.r { text-align: right; }
.items tbody td {
  font-weight: 600;
  font-size: 12px;
  padding: 2px 0;
  vertical-align: top;
  line-height: 1.25;
  border-bottom: 1px dashed #000;
}
.items tbody tr:last-child td { border-bottom: none; }
.items td.n {
  text-align: left;
  word-break: break-word;
  overflow-wrap: break-word;
  white-space: normal;
}
.items td.r { text-align: right; white-space: nowrap; }
.totals-wrap {
  border-top: 1px solid #000;
  padding-top: 2px;
  width: 100%;
}
.totals {
  display: grid;
  grid-template-columns: 1fr 20% 24%;
  width: 100%;
  font-size: 11px;
  line-height: 1.3;
}
.totals .row { display: contents; }
.totals .lab {
  text-align: right;
  font-weight: 400;
  font-size: 11px;
  padding: 1px 3px 1px 0;
  white-space: nowrap;
}
.totals .lab::after { content: " :"; }
.totals .base {
  text-align: right;
  font-weight: 400;
  font-size: 11px;
  padding: 1px 0;
  white-space: nowrap;
}
.totals .amt {
  text-align: right;
  font-weight: 400;
  font-size: 11px;
  padding: 1px 0;
  white-space: nowrap;
}
.totals .row.total-row .lab,
.totals .row.total-row .amt {
  font-weight: 700;
  font-size: 11px;
  padding-top: 1px;
}
.totals .row.net-row .lab,
.totals .row.net-row .amt {
  font-weight: 700;
  font-size: 16px;
  padding-top: 6px;
  line-height: 1.2;
}
.totals .row.net-row .base { padding-top: 6px; }
.words {
  font-size: 11px;
  font-weight: 400;
  line-height: 1.3;
  margin-top: 6px;
  text-align: left;
  word-break: break-word;
}
.thanks {
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.3;
  margin: 6px 0 0;
}
.bill-remark {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sign {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 700;
  margin-top: 8px;
}
@media print {
  html, body {
    width: 80mm;
    max-width: 80mm;
    margin: 0;
    padding: 0;
  }
  .slip {
    width: 72mm;
    max-width: 300px;
    margin: 0 auto;
    padding: 2mm 3mm 5mm;
    overflow: hidden;
  }
}
`.trim();

/**
 * THE BOSS 80mm bill — HTML/CSS (Arial), matches native IBS/Windows slip.
 * Values come from payload only; sample data is for visual tests.
 */
export function renderBillReceiptHtml(payload: BillReceiptPayload): string {
  const venue = payload.venue ?? BILL_VENUE_DEFAULTS;
  const { date, time } = billDateParts(payload.createdAt);
  const outlet = outletLabel(payload.outlet);
  const remark = payload.remark?.trim();
  const footer = (venue.footer || BILL_VENUE_DEFAULTS.footer || "~~** Thanks for coming--Visit Again**~").trim();

  const itemRows = payload.items
    .map(
      (it) => `
      <tr>
        <td class="n">${esc(it.name.toUpperCase())}</td>
        <td class="r">${esc(money(it.rate))}</td>
        <td class="r">${esc(String(it.qty))}</td>
        <td class="r">${esc(money(it.amount))}</td>
      </tr>`,
    )
    .join("");

  const totalLines = payload.totalLines?.length
    ? payload.totalLines.map((row) => ({
        label: row.label.replace(/\s*:\s*$/, ""),
        base: row.base != null ? (typeof row.base === "number" ? money(row.base) : String(row.base)) : "",
        amount: row.amount,
      }))
    : defaultTotalRows(payload);

  const totalRowsHtml = totalLines
    .map(
      (row) => `
      <div class="row">
        <div class="lab">${esc(row.label)}</div>
        <div class="base">${esc(row.base || "")}</div>
        <div class="amt">${esc(money(row.amount))}</div>
      </div>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Bill ${esc(payload.billNo)}</title>
<style>${CSS}</style>
</head>
<body>
  <div class="slip">
    <div class="center">
      <div class="biz-name">${esc(venue.name)}</div>
      <div class="biz-unit">${esc(venue.unit)}</div>
      <div class="biz-line">${esc(venue.address1)}</div>
      <div class="biz-line">${esc(venue.address2)}</div>
      <div class="biz-line">${esc(venue.address3)}</div>
      <div class="biz-line">${esc(venue.contact)}</div>
      <div class="biz-line">GSTIN : ${esc(venue.gstin)}</div>
      <div class="biz-line">HSN/SAC Code : ${esc(venue.hsn)}</div>
      <div class="biz-line">TIN NO. ${esc(venue.tin)}</div>
      <div class="outlet">${esc(outlet)}</div>
    </div>

    <div class="meta">
      <div class="meta-left">
        <div class="row"><span class="lbl">Bill No.</span><span class="colon">:</span><span class="val">${esc(payload.billNo)}</span></div>
        <div class="row"><span class="lbl">Table No.</span><span class="colon">:</span><span class="val">${esc(payload.tableNo)}</span></div>
        <div class="row"><span class="lbl">Waiter.</span><span class="colon">:</span><span class="val">${esc(stewardInitial(payload.waiter))}</span></div>
        <div class="row"><span class="lbl">Name</span><span class="colon">:</span><span class="val">${esc(payload.guestName?.trim() || "")}</span></div>
        ${payload.guestGstin?.trim() ? `<div class="row"><span class="lbl">GSTIN</span><span class="colon">:</span><span class="val">${esc(payload.guestGstin.trim())}</span></div>` : ""}
      </div>
      <div class="meta-right">
        <div class="row"><span class="lbl">Date</span><span class="val">${esc(date)}</span></div>
        <div class="row"><span class="lbl">Time</span><span class="val">${esc(time)}</span></div>
        <div class="row"><span class="lbl">Pax</span><span class="val">:${esc(payload.pax?.trim() || "")}</span></div>
      </div>
    </div>

    <table class="items">
      <colgroup>
        <col class="c-name" /><col class="c-rate" /><col class="c-qty" /><col class="c-amt" />
      </colgroup>
      <thead>
        <tr>
          <th class="n">ItemName</th>
          <th class="r">Rate</th>
          <th class="r">Qty</th>
          <th class="r">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
    </table>

    <div class="totals-wrap">
      <div class="totals">
        <div class="row total-row">
          <div class="lab">Total</div>
          <div class="base"></div>
          <div class="amt">${esc(money(payload.subtotal))}</div>
        </div>
        ${totalRowsHtml}
        <div class="row net-row">
          <div class="lab">Net Total</div>
          <div class="base"></div>
          <div class="amt">${esc(money(payload.netTotal))}</div>
        </div>
      </div>
    </div>

    <div class="words">${esc(amountInWords(payload.netTotal))}</div>
    ${remark ? `<div class="bill-remark"><strong>Remark:</strong> ${esc(remark)}</div>` : ""}
    <div class="thanks">${esc(footer)}</div>
    <div class="sign"><span>E.&.O.E</span><span>Guest Signature</span></div>
  </div>
</body>
</html>`;
}
