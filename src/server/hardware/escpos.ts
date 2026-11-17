import {
  BILL_VENUE_DEFAULTS,
  type BillReceiptPayload,
  type BillVenueInfo,
  type KotPrintPayload,
  type ReceiptPayload,
  type SimpleReceiptPayload,
} from "./types.js";
import { buildBillTotalLines } from "./billTotals.js";

/**
 * Match native IBS / THE BOSS slips on EPSON TM-T82 (80mm).
 * Font A, 48 cols ≈ 72–76mm printable. Do NOT set GS L / GS W — those stick
 * on the printer and can clip Qty on later IBS Windows-driver prints.
 */
export const KOT_COLS = 48;
export const BILL_COLS = 48;

const ESC = 0x1b;
const GS = 0x1d;

const COLON_AT = 10;
const QTY_W = 3;

function enc(text: string): Buffer {
  return Buffer.from(text, "ascii");
}

function line(text = ""): Buffer {
  return enc(`${text}\n`);
}

function field(label: string, value: string): string {
  const head = label.length >= COLON_AT ? `${label}:` : `${label}${" ".repeat(COLON_AT - label.length)}:`;
  const tag = `${head} `;
  return `${tag}${String(value).slice(0, Math.max(0, KOT_COLS - tag.length))}`;
}

function wrapName(name: string, width: number): string[] {
  const words = name.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w.slice(0, width);
      continue;
    }
    if (`${cur} ${w}`.length <= width) cur = `${cur} ${w}`;
    else {
      lines.push(cur);
      cur = w.slice(0, width);
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function itemRow(name: string, qty: string): string[] {
  const nameWidth = KOT_COLS - QTY_W - 1;
  const names = wrapName(name, nameWidth);
  const qtyCell = qty.slice(0, QTY_W).padStart(QTY_W, " ");
  return names.map((n, i) => {
    const left = n.padEnd(nameWidth, " ").slice(0, nameWidth);
    return i === 0 ? `${left}|${qtyCell}` : `${left}|${" ".repeat(QTY_W)}`;
  });
}

function headerRow(): string {
  const nameWidth = KOT_COLS - QTY_W - 1;
  return `${"Item Name".padEnd(nameWidth, " ").slice(0, nameWidth)}|${"Qty".padStart(QTY_W, " ")}`;
}

export function escInit(): Buffer {
  // ESC @ clears margins/size/underline left by a prior job (needed so IBS Qty is not clipped)
  return Buffer.from([ESC, 0x40, ESC, 0x4d, 0x00]);
}

/** Restore printer defaults after our job so IBS Windows prints stay full-width. */
export function escReset(): Buffer {
  return Buffer.from([ESC, 0x40]);
}

export function escCut(): Buffer {
  return Buffer.from([GS, 0x56, 0x00]);
}

export function escFeed(n = 3): Buffer {
  return Buffer.from([ESC, 0x64, Math.max(0, Math.min(255, n))]);
}

function align(n: 0 | 1 | 2): Buffer {
  return Buffer.from([ESC, 0x61, n]);
}

function bold(on: boolean): Buffer {
  return Buffer.from([ESC, 0x45, on ? 1 : 0]);
}

/** Double-strike — darker dots on TM-T82. */
function dark(on: boolean): Buffer {
  return Buffer.from([ESC, 0x47, on ? 1 : 0]);
}

/** Bold + double-strike for headings / emphasis. */
function heavy(on: boolean): Buffer[] {
  return [bold(on), dark(on)];
}

/** 0 off, 1 thin, 2 thick (native RUNNING ORDER / Original Copy). */
function underline(mode: 0 | 1 | 2): Buffer {
  return Buffer.from([ESC, 0x2d, mode]);
}

/** Double width + double height — native IBS BAR / KITCHEN / business name. */
function sizeTitle(): Buffer {
  return Buffer.from([ESC, 0x21, 0x30]);
}

/** Double height only — Net Total prominence without halving columns. */
function sizeTall(): Buffer {
  return Buffer.from([ESC, 0x21, 0x10]);
}

function sizeNormal(): Buffer {
  return Buffer.from([ESC, 0x21, 0x00]);
}

/** Solid rule across the content width (native 18:33). */
function solidRule(): Buffer[] {
  return [underline(2), line(" ".repeat(KOT_COLS)), underline(0)];
}

function dashedRule(cols = BILL_COLS): Buffer {
  return line("-".repeat(cols));
}

/** Light dotted row separator between bill items (native slip). */
function dottedRule(cols = BILL_COLS): Buffer {
  return line(".".repeat(cols));
}

function centerText(text: string, width: number): string {
  const s = text.slice(0, width);
  if (s.length >= width) return s;
  const left = Math.floor((width - s.length) / 2);
  return `${" ".repeat(left)}${s}${" ".repeat(width - left - s.length)}`;
}

function centerQty(qty: number, width: number): string {
  return centerText(String(qty), width);
}

function metaLeft(label: string, value: string, width = 28): string {
  const head = `${label.padEnd(10, " ")}:`;
  return `${head}${value}`.slice(0, width).padEnd(width, " ");
}

function kotCopy(payload: KotPrintPayload): string {
  return payload.reprint ? "Reprint Copy" : "Original Copy";
}

function orderBanner(payload: KotPrintPayload): string {
  return payload.orderBanner === "NEW ORDER" ? "NEW ORDER" : "RUNNING ORDER";
}

function formatKotDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso.slice(0, KOT_COLS);
  const day = when.getDate();
  const mon = when.toLocaleString("en-GB", { month: "short" });
  const year = when.getFullYear();
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  const ss = String(when.getSeconds()).padStart(2, "0");
  // Native: "17 Nov 2026  18:33:06"
  return `${day} ${mon} ${year}  ${hh}:${mm}:${ss}`;
}

export function formatKotEscPos(payload: KotPrintPayload): Buffer {
  const chunks: Buffer[] = [escInit()];
  const kotNo = String(payload.kotNumber).replace(/\D/g, "") || payload.kotNumber;
  const station = payload.station === "BAR" ? "BAR" : "KITCHEN";

  // Native IBS bottom-slip sample: tight top, heavy BAR, then Restaurant KOT
  chunks.push(line());

  chunks.push(align(1));
  chunks.push(sizeTitle());
  chunks.push(...heavy(true));
  chunks.push(line(station));
  chunks.push(sizeNormal());
  chunks.push(...heavy(false));
  chunks.push(...heavy(true));
  chunks.push(line("Restaurant KOT"));
  chunks.push(...heavy(false));
  chunks.push(align(0));

  // Meta block — denser leading like native (no blank between header and fields)
  chunks.push(dark(true));
  chunks.push(line(field("KOT No.", kotNo)));
  chunks.push(line(field("Table No.", payload.tableCode)));
  chunks.push(line(field("Date", formatKotDate(payload.createdAt))));
  chunks.push(line(field("Stward", payload.waiter?.trim() || "")));
  chunks.push(dark(false));
  chunks.push(line());

  // Centered heavy + thick underline: NEW ORDER / RUNNING ORDER, then Original/Reprint Copy
  chunks.push(align(1));
  chunks.push(...heavy(true));
  chunks.push(underline(2));
  chunks.push(line(orderBanner(payload)));
  chunks.push(underline(0));
  chunks.push(line(kotCopy(payload)));
  chunks.push(...heavy(false));
  chunks.push(align(0));

  chunks.push(...solidRule());
  chunks.push(...heavy(true));
  chunks.push(line(headerRow()));
  chunks.push(...heavy(false));
  chunks.push(...solidRule());

  chunks.push(dark(true));
  for (const item of payload.items) {
    for (const row of itemRow(item.name, String(item.qty))) chunks.push(line(row));
  }
  chunks.push(dark(false));

  chunks.push(...solidRule());
  const remark = String(payload.remark ?? "").trim();
  if (remark) {
    chunks.push(dark(true));
    for (const n of wrapName(remark, KOT_COLS)) chunks.push(line(n));
    chunks.push(dark(false));
  }

  chunks.push(escFeed(4));
  chunks.push(escCut());
  // Clear any size/underline/align so the next IBS job is full-width again
  chunks.push(escReset());
  return Buffer.concat(chunks);
}

/** Rupees with 2 decimals, no currency symbol (native bill sample). */
function money(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}

function padPair(left: string, right: string, cols = BILL_COLS): string {
  const gap = Math.max(1, cols - left.length - right.length);
  return `${left}${" ".repeat(gap)}${right}`.slice(0, cols);
}

function totalLine(label: string, paise: number, cols = BILL_COLS): string {
  return padPair(label, money(paise), cols);
}

/** Indian-style amount in words for whole rupees (paise rounded). */
export function amountInWords(paise: number): string {
  const rupees = Math.round(Math.abs(paise) / 100);
  if (rupees === 0) return "Rs. Zero Only";
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  function underThousand(n: number): string {
    if (n < 20) return ones[n];
    if (n < 100) {
      const t = Math.floor(n / 10);
      const o = n % 10;
      return o ? `${tens[t]} ${ones[o]}` : tens[t];
    }
    const h = Math.floor(n / 100);
    const rest = n % 100;
    return rest ? `${ones[h]} Hundred ${underThousand(rest)}` : `${ones[h]} Hundred`;
  }
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rem = rupees % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${underThousand(crore)} Crore`);
  if (lakh) parts.push(`${underThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${underThousand(thousand)} Thousand`);
  if (rem) parts.push(underThousand(rem));
  return `Rs. ${parts.join(" ")} Only`;
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

/** ItemName left | Rate right | Qty center | Amount right — 48 cols. */
const NAME_W = 24;
const RATE_W = 10;
const BILL_QTY_W = 5;
const AMT_W = 9;

function billItemRows(name: string, rate: number, qty: number, amount: number): string[] {
  const names = wrapName(name.toUpperCase(), NAME_W);
  const rateCell = money(rate).padStart(RATE_W, " ");
  const qtyCell = centerQty(qty, BILL_QTY_W);
  const amtCell = money(amount).padStart(AMT_W, " ");
  return names.map((n, i) => {
    const left = n.padEnd(NAME_W, " ").slice(0, NAME_W);
    if (i === 0) return `${left}${rateCell}${qtyCell}${amtCell}`;
    return `${left}${" ".repeat(RATE_W + BILL_QTY_W + AMT_W)}`;
  });
}

function pushVenueHeader(chunks: Buffer[], venue: BillVenueInfo): void {
  chunks.push(align(1));

  // ~23px/800 — double-width+height + heavy
  chunks.push(sizeTitle());
  chunks.push(...heavy(true));
  chunks.push(line(venue.name.toUpperCase().slice(0, 24)));
  chunks.push(sizeNormal());
  // ~14px/700 subtitle
  chunks.push(line(venue.unit.slice(0, BILL_COLS)));
  chunks.push(...heavy(false));

  // Address / contact / tax ids — centered, darker body (~12px)
  chunks.push(dark(true));
  if (venue.address1) chunks.push(line(venue.address1.slice(0, BILL_COLS)));
  if (venue.address2) chunks.push(line(venue.address2.slice(0, BILL_COLS)));
  if (venue.address3) chunks.push(line(venue.address3.slice(0, BILL_COLS)));
  if (venue.contact) chunks.push(line(venue.contact.slice(0, BILL_COLS)));
  chunks.push(line(venue.gstin ? `GSTIN : ${venue.gstin}` : "GSTIN :"));
  chunks.push(line(venue.hsn ? `HSN/SAC Code : ${venue.hsn}` : "HSN/SAC Code :"));
  chunks.push(line(venue.tin ? `TIN NO. : ${venue.tin}` : "TIN NO. :"));
  chunks.push(dark(false));
  chunks.push(line());
}

function buildDefaultTotalLines(payload: BillReceiptPayload): Array<{ label: string; amount: number }> {
  return buildBillTotalLines({
    lines: payload.items.map((it) => ({ amount: it.amount, taxRate: 0, salesGroup: "" })),
    discount: payload.discount,
    discountPct: payload.discountPct,
    serviceCharge: payload.serviceCharge,
    serviceChargePct: payload.serviceChargePct,
    otherCharges: payload.otherCharges,
    roundOff: payload.roundOff,
    taxTotal: payload.tax,
  }).map((row) => ({
    label: `${row.label} :`,
    amount: row.amount,
  }));
}

export function formatBillEscPos(payload: BillReceiptPayload): Buffer {
  const chunks: Buffer[] = [escInit(), line()];
  const venue = payload.venue ?? BILL_VENUE_DEFAULTS;
  const { date, time } = billDateParts(payload.createdAt);
  const outlet = outletLabel(payload.outlet);

  pushVenueHeader(chunks, venue);

  // BAR / outlet heading ~16px/700
  chunks.push(align(1));
  chunks.push(...heavy(true));
  chunks.push(sizeTall());
  chunks.push(line(outlet));
  chunks.push(sizeNormal());
  chunks.push(...heavy(false));
  chunks.push(align(0));
  chunks.push(line());

  // Two-column bill info (~13px)
  chunks.push(dark(true));
  chunks.push(line(`${metaLeft("Bill No.", payload.billNo)}Date ${date}`.slice(0, BILL_COLS)));
  chunks.push(line(`${metaLeft("Table No.", payload.tableNo)}Time ${time}`.slice(0, BILL_COLS)));
  chunks.push(
    line(
      `${metaLeft("Waiter.", payload.waiter?.trim() || "")}Pax  :${payload.pax?.trim() ? ` ${payload.pax.trim()}` : ""}`.slice(
        0,
        BILL_COLS,
      ),
    ),
  );
  chunks.push(line(metaLeft("Name", payload.guestName?.trim() || "", BILL_COLS).trimEnd()));
  chunks.push(dashedRule());

  // Column headings ~13px/700
  chunks.push(...heavy(true));
  chunks.push(
    line(
      `${"ItemName".padEnd(NAME_W, " ")}${"Rate".padStart(RATE_W, " ")}${centerText("Qty", BILL_QTY_W)}${"Amount".padStart(AMT_W, " ")}`,
    ),
  );
  chunks.push(...heavy(false));
  chunks.push(dark(true));
  chunks.push(dashedRule());

  for (let i = 0; i < payload.items.length; i++) {
    const item = payload.items[i];
    for (const row of billItemRows(item.name, item.rate, item.qty, item.amount)) {
      chunks.push(line(row));
    }
    if (i < payload.items.length - 1) chunks.push(dottedRule());
  }

  chunks.push(dashedRule());
  // Total ~15px/700
  chunks.push(...heavy(true));
  chunks.push(line(totalLine("Total :", payload.subtotal)));
  chunks.push(...heavy(false));
  chunks.push(dark(true));

  const totals = payload.totalLines?.length ? payload.totalLines : buildDefaultTotalLines(payload);
  for (const row of totals) {
    chunks.push(line(totalLine(row.label, row.amount)));
  }

  // NET TOTAL ~20px/800 — double height + heavy
  chunks.push(line());
  chunks.push(...heavy(true));
  chunks.push(sizeTall());
  chunks.push(line(totalLine("Net Total :", payload.netTotal)));
  chunks.push(sizeNormal());
  chunks.push(...heavy(false));
  chunks.push(dark(true));
  chunks.push(dashedRule());

  for (const part of wrapName(amountInWords(payload.netTotal), BILL_COLS)) {
    chunks.push(line(part));
  }
  chunks.push(line());
  chunks.push(align(1));
  chunks.push(...heavy(true));
  chunks.push(line((venue.footer || BILL_VENUE_DEFAULTS.footer || "").slice(0, BILL_COLS)));
  chunks.push(...heavy(false));
  chunks.push(align(0));
  chunks.push(line());
  chunks.push(...heavy(true));
  chunks.push(line(padPair("E.&.O.E", "Guest Signature")));
  chunks.push(...heavy(false));
  chunks.push(dark(false));

  chunks.push(escFeed(4));
  chunks.push(escCut());
  chunks.push(escReset());
  return Buffer.concat(chunks);
}

function isBillPayload(payload: ReceiptPayload): payload is BillReceiptPayload {
  return (payload as BillReceiptPayload).kind === "bill";
}

export function formatReceiptEscPos(payload: ReceiptPayload): Buffer {
  if (isBillPayload(payload)) return formatBillEscPos(payload);

  const simple = payload as SimpleReceiptPayload;
  const chunks: Buffer[] = [escInit()];
  chunks.push(line());
  chunks.push(align(1));
  chunks.push(bold(true));
  chunks.push(line(simple.title.slice(0, BILL_COLS)));
  chunks.push(bold(false));
  chunks.push(align(0));
  chunks.push(dashedRule());
  for (const raw of simple.lines) {
    for (const part of wrapName(raw, BILL_COLS)) chunks.push(line(part));
  }
  if (simple.footer) {
    chunks.push(dashedRule());
    for (const part of wrapName(simple.footer, BILL_COLS)) chunks.push(line(part));
  }
  chunks.push(escFeed(4));
  chunks.push(escCut());
  chunks.push(escReset());
  return Buffer.concat(chunks);
}

/** Layout test only — mirrors the reference slip; live Print Bill uses invoice + settings. */
export function sampleBillPayload(): BillReceiptPayload {
  return {
    kind: "bill",
    venue: { ...BILL_VENUE_DEFAULTS },
    outlet: "BAR",
    billNo: "26-27/24151",
    tableNo: "BEYOND UD",
    waiter: "A",
    guestName: "",
    pax: "",
    createdAt: "2026-11-06T23:58:00+05:30",
    items: [
      { name: "BOMBAY SAPPHIRE BTL", rate: 999900, qty: 1, amount: 999900 },
      { name: "KINGFISHER ULTRA PINT", rate: 54900, qty: 4, amount: 219600 },
      { name: "BREEZER 275 ML JAMAICAN", rate: 57900, qty: 3, amount: 173700 },
      { name: "JAGER BOMB", rate: 59900, qty: 2, amount: 119800 },
      { name: "TONIC WATER", rate: 22900, qty: 4, amount: 91600 },
      { name: "ABSOLUTE 30 ML", rate: 44900, qty: 2, amount: 89800 },
      { name: "REDBULL", rate: 32900, qty: 2, amount: 65800 },
      { name: "AERATED DRINK", rate: 19900, qty: 1, amount: 19900 },
    ],
    subtotal: 1780100,
    discount: 267015,
    discountPct: 15,
    tax: 27126,
    serviceCharge: 0,
    serviceChargePct: 0,
    otherCharges: 0,
    roundOff: 17,
    netTotal: 1867200,
    totalLines: [
      { label: "Discount 15.00 %", amount: 267015 },
      { label: "Vat 20%", base: 1362380, amount: 272476 },
      { label: "Surcharge", base: 272476, amount: 54495 },
      { label: "S.C. VOLUNTARY 10 %", amount: 151309 },
      { label: "CGST 9.0%", base: 150705, amount: 13563 },
      { label: "SGST 9.0%", base: 150705, amount: 13563 },
      { label: "Round Off", amount: 17 },
    ],
  };
}

export function formatTestEscPos(_printerName: string, _host: string): Buffer {
  return formatKotEscPos({
    kotNumber: "KOT-74305",
    tableCode: "PARTEEK SIR",
    waiter: "A",
    station: "BAR",
    reprint: false,
    orderBanner: "RUNNING ORDER",
    remark: "TEST ITEM KOT",
    createdAt: new Date().toISOString(),
    items: [{ qty: 1, name: "AAA" }],
  });
}

export function formatTestBillEscPos(): Buffer {
  return formatBillEscPos(sampleBillPayload());
}
