import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ignoreRepeatedPrintKey, printBill, printPage, reprintKot } from "./printActions";
import { createPortal } from "react-dom";
import { api } from "./api";
import { parseRupeesInput } from "../shared/money";
import type { NavView } from "../shared/types";
import { AlertBox, CapBtns, ConfirmAsk, PrepareBillDialog, SettleDialog } from "./BillDialogs";
import { cardNoDigits, cardNoReady, stayOnCard } from "./formNav";
import type { CompAccount } from "./ComplimentaryMaster";

const OUTLETS = ["BAR", "CAFE", "NC", "RESTAURANT", "THE BOSS CLUB"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function useReportRequest() {
  const current = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => current.current?.abort(), []);

  async function load<T>(path: string, apply: (result: T) => void) {
    current.current?.abort();
    const request = new AbortController();
    current.current = request;
    setLoading(true);
    setError("");
    try {
      const result = await api.get<T>(path, request.signal);
      if (!request.signal.aborted) apply(result);
    } catch (error) {
      if (!request.signal.aborted) setError(error instanceof Error ? error.message : "Could not load report.");
    } finally {
      if (current.current === request && !request.signal.aborted) setLoading(false);
    }
  }
  return { load, loading, error };
}

function ReportLoadStatus({ loading, error }: { loading: boolean; error: string }) {
  if (loading) return <div className="report-load-status" role="status">Loading report…</div>;
  if (error) return <div className="report-load-status" role="alert">{error}</div>;
  return null;
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function dmy(d = new Date()) {
  return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}
function isoDay(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function rupees(paise?: number) {
  return ((paise || 0) / 100).toFixed(2);
}
function inr(paise?: number) {
  return ((paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CrystalChrome({ children, onExit, onExport, toolsVisible, onToggleTools }: {
  children: ReactNode;
  onExit: () => void;
  onExport?: () => void;
  toolsVisible?: boolean;
  onToggleTools?: () => void;
}) {
  return (
    <div className="cr-shell">
      <div className="cr-toolbar">
        <button className="fn" onKeyDown={ignoreRepeatedPrintKey} onClick={printPage}>Print</button>
        {onExport ? <button className="fn" onClick={onExport}>Export</button> : <button className="fn">Export</button>}
        {onToggleTools
          ? <button className="fn" onClick={onToggleTools}>{toolsVisible ? "Hide" : "Show"}</button>
          : <button className="fn">Show</button>}
        <button className="fn" onClick={onExit}>Exit</button>
        <span className="cr-brand">SAP CRYSTAL REPORTS®</span>
      </div>
      <div className="cr-stage">{children}</div>
      <div className="cr-status">
        <span>Current Page No.: 1</span>
        <span>Total Page No.: 1</span>
        <span>Zoom Factor: 100%</span>
      </div>
    </div>
  );
}

function FilterDates({ from, to, setFrom, setTo, onShow }: {
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; onShow?: () => void;
}) {
  return (
    <span className="flt-dates">
      <label>From <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      {onShow && <button className="fn" onClick={onShow}>Refresh</button>}
    </span>
  );
}

export function ItemWiseDetail({ onExit }: { onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [data, setData] = useState<any>({ rows: [] });
  const [shown, setShown] = useState(true);
  async function load() {
    setData(await api.get(`/api/reports/item-wise?from=${from}&to=${to}`));
    setShown(true);
  }
  useEffect(() => { load().catch(() => null); }, []);
  const rows = data.rows ?? [];
  return (
    <div className="rpt-page">
      <div className="rpt-bar">
        <label>Outlet Name: <select className="win"><option>Select</option>{OUTLETS.map((o) => <option key={o}>{o}</option>)}</select></label>
        <label>Sales Group: <select className="win"><option>Select</option></select></label>
        <label>Item Name: <select className="win"><option>Select</option></select></label>
        <label>Date From : <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To Date : <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>Item Group: <select className="win"><option>Select</option></select></label>
        <button className="fn" onClick={load}>Show</button>
        <button className="fn" onClick={onExit}>Exit</button>
      </div>
      {shown && (
        <CrystalChrome onExit={onExit}>
          <div className="cr-paper">
            <h1>THE BOSS</h1>
            <div className="cr-sub">(A UNIT OF BROTZEIT95)</div>
            <div className="cr-sub">PH : 7908890041</div>
            <h2>Item Wise Sales</h2>
            <div className="cr-meta">
              Date From {dmy(new Date(from))} To {dmy(new Date(to))}<br />
              UserName : {""}TRIJOK
              <span className="cr-page">Page No. : Page 1 of 1</span>
            </div>
            <table className="cr-table">
              <thead>
                <tr>
                  <th>Item Name</th><th>Bill No</th><th>Table No. / Room No</th>
                  <th>KOT</th><th>KOT Date &amp; Time</th><th>Qty</th><th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any, i: number) => (
                  <tr key={i}>
                    <td>{String(r.item_name || "").toUpperCase()}</td>
                    <td>{r.bill_no}</td>
                    <td>{r.table_no}</td>
                    <td>{r.kot?.replace(/\D/g, "") || ""}</td>
                    <td>{r.kot_at ? new Date(r.kot_at).toLocaleString("en-GB") : ""}</td>
                    <td>{Number(r.qty).toFixed(2)}</td>
                    <td>{inr(r.amount)}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={7} className="empty">No sales in this range</td></tr>}
              </tbody>
            </table>
          </div>
        </CrystalChrome>
      )}
    </div>
  );
}

export function PointOfSales({ onExit }: { onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [sel, setSel] = useState("CAFE");
  const [checked, setChecked] = useState<Record<string, boolean>>({
    CAFE: true, BAR: true, "THE BOSS CLUB": true, RESTAURANT: true, NC: true,
  });
  return (
    <div className="rpt-page pos-page">
      <div className="rpt-bar">
        <b>From</b>
        <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <b>To</b>
        <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="fn">Export</button>
        <button className="fn">Show</button>
        <button className="fn" onClick={onExit}>Exit</button>
      </div>
      <div className="pos-body">
        <aside className="pos-tree">
          {OUTLETS.map((o) => (
            <label key={o} className={sel === o ? "on" : ""} onClick={() => setSel(o)}>
              <input type="checkbox" checked={!!checked[o]} onChange={() => setChecked({ ...checked, [o]: !checked[o] })} />
              {o}
            </label>
          ))}
        </aside>
        <CrystalChrome onExit={onExit}>
          <div className="cr-paper">
            <h1>THE BOSS</h1>
            <h2>Point Of Sales</h2>
            <div className="cr-meta">From : {dmy(new Date(from))} &nbsp; To : {dmy(new Date(to))}</div>
            <p className="empty">Select outlets and click Show.</p>
          </div>
        </CrystalChrome>
      </div>
    </div>
  );
}

const GST_COLS: Array<[string, string, boolean?]> = [
  ["bill_no", "Bill No"],
  ["bill_date", "Bill Date"],
  ["client_name", "ClientName"],
  ["gstin", "GSTIN"],
  ["amount", "Amount", true],
  ["discount", "Discount", true],
  ["gross_amount", "Gross Amount", true],
  ["service_charge", "ServiceCharge", true],
  ["net_18", "Net 18%", true],
  ["sgst_9", "SGST 9%", true],
  ["cgst_9", "CGST 9%", true],
  ["net_20", "NET 20%", true],
  ["vat_20", "VAT 20%", true],
  ["net_surchar", "NETSurCh", true],
  ["surchar_20", "SurChar", true],
  ["round_off", "RoundOff", true],
  ["net_amount", "NetAmount", true],
  ["mop", "MOP"],
  ["payment_modes", "PaymentModes"],
];

function gstAmt(paise?: number) {
  return ((Number(paise) || 0) / 100).toFixed(2);
}
/** Native GST Summery slip amounts (Indian commas). */
function gstSumAmt(paise?: number) {
  return ((Number(paise) || 0) / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function gstSlipDate(isoDayStr: string) {
  const d = new Date(isoDayStr);
  if (Number.isNaN(d.getTime())) return isoDayStr;
  return `${pad(d.getDate())}/${MONTHS[d.getMonth()]}/${d.getFullYear()}`;
}

/** Bottom of the FnB GST Summery — typed amounts, not taken from bills. */
const GST_CASH_LINES: Array<{ id: string; label: string }> = [
  { id: "club_card_return", label: "CLUB CARD RETURN" },
  { id: "incentives", label: "INCENTIVES AMOUNT" },
  { id: "expense", label: "CASH AFTER EXPENSE" },
  { id: "entry_sale", label: "ENTRY SALE" },
  { id: "party_payment", label: "Party Payment Cash Rec. Not Punch In Sale" },
  { id: "system_cash", label: "System Cash Sale" },
  { id: "cash_in_hand", label: "Cash in hand" },
];

type GstExtraLine = { id: string; label: string; amount: string };
type GstManualSheet = {
  amounts: Record<string, string>;
  extras: GstExtraLine[];
  hidden: string[];
  saleLines: GstExtraLine[];
};

/** Hand-typed lines. A day with nothing saved starts at 0.00. */
const GST_HAND_IDS = ["club_card_return", "incentives", "party_payment"];

function blankHandAmounts(): Record<string, string> {
  return Object.fromEntries(GST_HAND_IDS.map((id) => [id, "0.00"]));
}

function gstManualStorageKey(from: string, to: string) {
  return `${from}|${to}`;
}

function keptLines(rows: GstExtraLine[] | undefined) {
  return Array.isArray(rows) ? rows.filter((x) => x && typeof x.id === "string") : [];
}

function resizeGstLabel(target: HTMLTextAreaElement | null) {
  if (!target) return;
  target.style.height = "auto";
  target.style.height = `${target.scrollHeight}px`;
}

function loadGstManual(from: string, to: string): GstManualSheet {
  const empty: GstManualSheet = { amounts: blankHandAmounts(), extras: [], hidden: [], saleLines: [] };
  try {
    const raw = localStorage.getItem("boss-gst-manual");
    if (!raw) return empty;
    const all = JSON.parse(raw) as Record<string, { amounts?: Record<string, string>; extras?: GstExtraLine[]; hidden?: string[]; saleLines?: GstExtraLine[] }>;
    const row = all[gstManualStorageKey(from, to)];
    if (!row) return empty;
    const hidden = Array.isArray(row.hidden) ? row.hidden.filter((id) => typeof id === "string") : [];
    return {
      amounts: { ...blankHandAmounts(), ...(row.amounts && typeof row.amounts === "object" ? row.amounts : {}) },
      extras: keptLines(row.extras),
      hidden,
      saleLines: keptLines(row.saleLines),
    };
  } catch {
    return empty;
  }
}

function saveGstManual(from: string, to: string, sheet: GstManualSheet) {
  try {
    const raw = localStorage.getItem("boss-gst-manual");
    const all = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    all[gstManualStorageKey(from, to)] = sheet;
    localStorage.setItem("boss-gst-manual", JSON.stringify(all));
  } catch {
    /* private mode or full storage — the slip still shows what was typed */
  }
}

function formatManualAmt(raw: string) {
  const cleaned = raw.replace(/[₹,\s]/g, "").trim();
  if (!cleaned) return "";
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function manualRupees(raw?: string) {
  const cleaned = String(raw ?? "").replace(/[₹,\s]/g, "").trim();
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function formatRupees(n: number) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Amount boxes accept digits and one decimal only. */
function amountTyping(raw: string) {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  if (dot < 0) return cleaned;
  const whole = cleaned.slice(0, dot);
  const frac = cleaned.slice(dot + 1).replace(/\./g, "").slice(0, 2);
  return `${whole}.${frac}`;
}

/** Particular row labelled CASH, in rupees. */
function cashParticularRupees(particulars: Array<{ label?: string; amount?: number }>) {
  let paise = 0;
  for (const p of particulars) {
    const label = String(p.label || "").toUpperCase().replace(/\s+/g, "");
    if (label === "CASH") paise += Number(p.amount) || 0;
  }
  return paise / 100;
}

/** CASH AFTER EXPENSE = CASH − (CLUB CARD RETURN + INCENTIVES AMOUNT). Hidden sources count as 0. */
function cashAfterExpense(cashRupees: number, amounts: Record<string, string>, hidden: string[]) {
  const club = hidden.includes("club_card_return") ? 0 : manualRupees(amounts.club_card_return);
  const incentives = hidden.includes("incentives") ? 0 : manualRupees(amounts.incentives);
  return formatRupees(cashRupees - club - incentives);
}

/** Cash in hand = (ENTRY SALE + party payment + system cash sale + added fields) − CASH AFTER EXPENSE. Hidden lines count as 0. */
function cashInHandAmount(
  entrySale: string,
  partyPayment: string,
  systemCash: string,
  expense: string,
  extras: Array<{ amount?: string }>,
  hidden: string[],
) {
  const off = (id: string) => hidden.includes(id);
  const added = extras.reduce((sum, line) => sum + manualRupees(line.amount), 0);
  const total = manualRupees(entrySale)
    + (off("party_payment") ? 0 : manualRupees(partyPayment))
    + (off("system_cash") ? 0 : manualRupees(systemCash))
    + added
    - (off("expense") ? 0 : manualRupees(expense));
  return formatRupees(total);
}

/** Total Sale = System Sale + every added row. */
function totalSaleAmount(systemSale: string, lines: GstExtraLine[]) {
  const added = lines.reduce((sum, line) => sum + manualRupees(line.amount), 0);
  return formatRupees(manualRupees(systemSale) + added);
}

/** ENTRY SALE is the Advance :CASH total already on the slip. */
function advanceCashPaise(particulars: Array<{ label?: string; amount?: number }>) {
  let sum = 0;
  for (const p of particulars) {
    const label = String(p.label || "").toUpperCase().replace(/\s+/g, "");
    if (!label.startsWith("ADVANCE:")) continue;
    const mop = label.slice("ADVANCE:".length);
    if (mop === "CASH" || mop.startsWith("CASH/") || mop.startsWith("CASH")) sum += Number(p.amount) || 0;
  }
  return sum;
}

export function GstReport({ onExit }: { onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [outletName, setOutletName] = useState("Select");
  const [billNo, setBillNo] = useState("");
  const [wise, setWise] = useState<"bill" | "date" | "month">("bill");
  const [taxReport, setTaxReport] = useState<"all" | "liquor" | "fnb">("all");
  const [settle, setSettle] = useState<"all" | "single" | "multi">("all");
  const [gstClient, setGstClient] = useState<"hide" | "gst" | "all">("all");
  const [cancelBill, setCancelBill] = useState(false);
  const [complimentary, setComplimentary] = useState(false);
  const [dateApply, setDateApply] = useState(true);
  const [withSettlement, setWithSettlement] = useState(false);
  const [view, setView] = useState<"empty" | "bills" | "summary">("empty");
  const [data, setData] = useState<any>({ rows: [], totals: {}, footer: {} });
  const [summary, setSummary] = useState<any>(null);
  const [cashAmounts, setCashAmounts] = useState<Record<string, string>>(blankHandAmounts);
  const [extraLines, setExtraLines] = useState<GstExtraLine[]>([]);
  const [saleLines, setSaleLines] = useState<GstExtraLine[]>([]);
  const [hiddenLines, setHiddenLines] = useState<string[]>([]);
  const [editTools, setEditTools] = useState(true);
  const [sel, setSel] = useState(-1);
  const selRef = useRef(-1);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onExit);
  selRef.current = sel;
  closeRef.current = onExit;

  function queryParams() {
    return new URLSearchParams({
      from,
      to,
      outlet: outletName,
      bill: billNo.trim(),
      tax: taxReport,
    });
  }

  function focusSelRow(scrollLast = false) {
    const wrap = gridWrapRef.current;
    if (!wrap) return;
    if (scrollLast) wrap.scrollTop = wrap.scrollHeight;
    const tr = wrap.querySelector("tbody tr.on") as HTMLElement | null;
    tr?.focus({ preventScroll: true });
    if (!scrollLast) tr?.scrollIntoView({ block: "nearest" });
  }

  async function loadBills() {
    const next = await api.get<any>(`/api/reports/gst?${queryParams()}`);
    setData(next);
    setView("bills");
    const rows = next.rows || [];
    setSel(rows.length ? rows.length - 1 : -1);
    requestAnimationFrame(() => focusSelRow(true));
  }

  async function loadTaxSummary() {
    const next = await api.get<any>(`/api/reports/gst?mode=summary&${queryParams()}`);
    setSummary(next);
    setData((d: any) => ({ ...d, footer: next.footer || d.footer }));
    setView("summary");
    // New cash table sits under Particular — bring that bottom of the slip into view
    requestAnimationFrame(() => {
      const slip = document.querySelector(".gst-summery-slip") as HTMLElement | null;
      if (slip) slip.scrollIntoView({ block: "start" });
    });
  }

  useEffect(() => {
    const loaded = loadGstManual(from, to);
    setCashAmounts(loaded.amounts);
    setExtraLines(loaded.extras);
    setSaleLines(loaded.saleLines);
    setHiddenLines(loaded.hidden);
  }, [from, to]);

  function sheetNow(partial: Partial<GstManualSheet>): GstManualSheet {
    return {
      amounts: partial.amounts ?? cashAmounts,
      extras: partial.extras ?? extraLines,
      hidden: partial.hidden ?? hiddenLines,
      saleLines: partial.saleLines ?? saleLines,
    };
  }

  function putCashAmount(id: string, value: string) {
    setCashAmounts((prev) => {
      const next = { ...prev, [id]: value };
      saveGstManual(from, to, sheetNow({ amounts: next }));
      return next;
    });
  }

  function putExtra(id: string, patch: Partial<GstExtraLine>) {
    setExtraLines((prev) => {
      const next = prev.map((line) => (line.id === id ? { ...line, ...patch } : line));
      saveGstManual(from, to, sheetNow({ extras: next }));
      return next;
    });
  }

  function addExtraLine() {
    const id = `x${Date.now().toString(36)}`;
    setExtraLines((prev) => {
      const next = [...prev, { id, label: "", amount: "" }];
      saveGstManual(from, to, sheetNow({ extras: next }));
      return next;
    });
    requestAnimationFrame(() => {
      document.getElementById(`gst-xl-${id}`)?.focus();
    });
  }

  function removeExtraLine(id: string) {
    setExtraLines((prev) => {
      const next = prev.filter((line) => line.id !== id);
      saveGstManual(from, to, sheetNow({ extras: next }));
      return next;
    });
  }

  function putSaleLine(id: string, patch: Partial<GstExtraLine>) {
    setSaleLines((prev) => {
      const next = prev.map((line) => (line.id === id ? { ...line, ...patch } : line));
      saveGstManual(from, to, sheetNow({ saleLines: next }));
      return next;
    });
  }

  function addSaleLine() {
    const id = `s${Date.now().toString(36)}`;
    setSaleLines((prev) => {
      const next = [...prev, { id, label: "", amount: "" }];
      saveGstManual(from, to, sheetNow({ saleLines: next }));
      return next;
    });
    requestAnimationFrame(() => {
      document.getElementById(`gst-sl-${id}`)?.focus();
    });
  }

  function removeSaleLine(id: string) {
    setSaleLines((prev) => {
      const next = prev.filter((line) => line.id !== id);
      saveGstManual(from, to, sheetNow({ saleLines: next }));
      return next;
    });
  }

  function hideLine(id: string) {
    setHiddenLines((prev) => {
      if (prev.includes(id)) return prev;
      const hidden = [...prev, id];
      saveGstManual(from, to, sheetNow({ hidden }));
      return hidden;
    });
  }

  function resetFields() {
    setHiddenLines([]);
    saveGstManual(from, to, sheetNow({ hidden: [] }));
  }

  async function exportPdf() {
    const name = `GST-Summery-${from}.pdf`;
    const bridge = window.bossPrint?.exportPdf;
    if (!bridge) {
      void printPage();
      return;
    }
    const raw = await bridge({ landscape: true });
    const bytes = raw instanceof Uint8Array
      ? raw
      : new Uint8Array(Array.isArray(raw?.data) ? raw.data : []);
    if (!bytes.byteLength) return;
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function onManualEnter(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const root = e.currentTarget.closest("table");
    if (!root) return;
    const inputs = [...root.querySelectorAll<HTMLInputElement>("input:not([readonly])")];
    const next = inputs[inputs.indexOf(e.currentTarget) + 1];
    if (next) next.focus();
  }

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (document.querySelector(".alert-dlg, .confirm-dlg, .confirm-overlay")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        // Own Escape before the app-level handler so GST always exits through its
        // current callback instead of allowing competing navigation handlers.
        e.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (view !== "bills") return;
      const rows = data.rows || [];
      if (!rows.length) return;
      const typing = (e.target as HTMLElement | null)?.closest("input, select, textarea");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (typing && (e.target as HTMLElement).tagName === "SELECT") return;
        e.preventDefault();
        e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur?.();
        const idx = Math.max(0, selRef.current);
        const next = e.key === "ArrowDown"
          ? Math.min(rows.length - 1, idx + 1)
          : Math.max(0, idx - 1);
        setSel(next);
        requestAnimationFrame(() => focusSelRow(false));
      }
    }
    function escapeUp(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (document.querySelector(".alert-dlg, .confirm-dlg, .confirm-overlay")) return;
      // Some report controls (especially the printable summary) consume Escape
      // during keydown. Repeat the exit on keyup so the main screen always opens.
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRef.current();
    }
    // Document capture runs before App's window capture handler. This makes GST's
    // Escape route deterministic even when the page is nested in the global host.
    document.addEventListener("keydown", keys, true);
    document.addEventListener("keyup", escapeUp, true);
    return () => {
      document.removeEventListener("keydown", keys, true);
      document.removeEventListener("keyup", escapeUp, true);
    };
  });

  useLayoutEffect(() => {
    if (view !== "bills") return;
    const rows = data.rows || [];
    if (!rows.length || sel !== rows.length - 1) return;
    focusSelRow(true);
  }, [view, data, sel]);

  const rows = data.rows || [];
  const totals = data.totals || {};
  const footer = (view === "summary" ? summary?.footer : data.footer) || {};
  const s = summary?.summary || {};
  const particulars = summary?.particulars || [];
  const entrySaleAmt = gstSumAmt(advanceCashPaise(particulars));
  const expenseShown = cashAfterExpense(cashParticularRupees(particulars), cashAmounts, hiddenLines);
  const systemSaleAmt = gstSumAmt(s.net_amount);
  const totalSaleAmt = totalSaleAmount(systemSaleAmt, saleLines);
  const cashInHandAmt = cashInHandAmount(
    entrySaleAmt,
    cashAmounts.party_payment ?? "0.00",
    expenseShown,
    expenseShown,
    extraLines,
    hiddenLines,
  );
  const fromLabel = gstSlipDate(from);
  const cashLines = GST_CASH_LINES.filter((line) => line.id !== "cash_in_hand" && line.id !== "system_cash" && !hiddenLines.includes(line.id));
  const systemCash = GST_CASH_LINES.find((line) => line.id === "system_cash")!;
  const cashInHand = GST_CASH_LINES.find((line) => line.id === "cash_in_hand")!;

  function cashRow(line: { id: string; label: string }, withAdd = false) {
    const locked = line.id === "entry_sale" || line.id === "cash_in_hand" || line.id === "expense" || line.id === "system_cash";
    const shown = line.id === "entry_sale" ? entrySaleAmt
      : line.id === "cash_in_hand" ? cashInHandAmt
      : line.id === "expense" || line.id === "system_cash" ? expenseShown
      : (cashAmounts[line.id] ?? "0.00");
    return (
      <tr key={line.id}>
        <td className="lbl">
          {line.label}
          {withAdd && <button type="button" className="fn gst-manual-plus" onClick={addExtraLine}>+</button>}
        </td>
        <td className={locked ? undefined : "amt-cell"}>
          <input
            className="win gst-amt-in"
            inputMode="decimal"
            readOnly={locked}
            tabIndex={locked ? -1 : undefined}
            value={shown}
            onChange={locked ? undefined : (e) => putCashAmount(line.id, amountTyping(e.target.value))}
            onBlur={locked ? undefined : (e) => putCashAmount(line.id, formatManualAmt(e.target.value))}
            onKeyDown={locked ? undefined : onManualEnter}
          />
          {!locked && <button type="button" className="fn gst-manual-del" onClick={() => hideLine(line.id)}>X</button>}
        </td>
      </tr>
    );
  }
  const toLabel = gstSlipDate(to);

  return (
    <div className="gst-page">
      <aside className="gst-filter">
        <div className="gst-cap">Filters</div>
        <label>From Date : <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To Date : <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="gst-radios">
          <label><input type="radio" name="gst-wise" checked={wise === "bill"} onChange={() => setWise("bill")} /> Bill Wise</label>
          <label><input type="radio" name="gst-wise" checked={wise === "date"} onChange={() => setWise("date")} /> Date Wise</label>
          <label><input type="radio" name="gst-wise" checked={wise === "month"} onChange={() => setWise("month")} /> Month Wise</label>
        </div>
        <label>Outlet Group: <select className="win" defaultValue="Select"><option>Select</option></select></label>
        <label>Outlet Name: <select className="win" value={outletName} onChange={(e) => setOutletName(e.target.value)}>
          <option>Select</option>{OUTLETS.map((o) => <option key={o}>{o}</option>)}
        </select></label>
        <label>MOP : <select className="win" defaultValue="Select"><option>Select</option><option>CASH</option><option>UPI</option><option>CARD</option></select></label>
        <label>Account : <select className="win" defaultValue="Select"><option>Select</option></select></label>
        <label>Bill No : <input className="win" value={billNo} onChange={(e) => setBillNo(e.target.value)} /></label>
        <fieldset>
          <legend>Tax Report</legend>
          <div className="gst-radios">
            <label><input type="radio" name="gst-tax" checked={taxReport === "all"} onChange={() => setTaxReport("all")} /> All Tax</label>
            <label><input type="radio" name="gst-tax" checked={taxReport === "liquor"} onChange={() => setTaxReport("liquor")} /> Liquor</label>
            <label><input type="radio" name="gst-tax" checked={taxReport === "fnb"} onChange={() => setTaxReport("fnb")} /> FnB</label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Settlement (Multi / Single)</legend>
          <div className="gst-radios">
            <label><input type="radio" name="gst-settle" checked={settle === "all"} onChange={() => setSettle("all")} /> All</label>
            <label><input type="radio" name="gst-settle" checked={settle === "single"} onChange={() => setSettle("single")} /> Single</label>
            <label><input type="radio" name="gst-settle" checked={settle === "multi"} onChange={() => setSettle("multi")} /> Multi</label>
          </div>
        </fieldset>
        <label><input type="checkbox" checked={cancelBill} onChange={(e) => setCancelBill(e.target.checked)} /> Cancel Bill</label>
        <label><input type="checkbox" checked={complimentary} onChange={(e) => setComplimentary(e.target.checked)} /> Complimentary</label>
        <fieldset>
          <legend>GST Client Details</legend>
          <div className="gst-radios">
            <label><input type="radio" name="gst-cli" checked={gstClient === "hide"} onChange={() => setGstClient("hide")} /> Not Show</label>
            <label><input type="radio" name="gst-cli" checked={gstClient === "gst"} onChange={() => setGstClient("gst")} /> Only GST</label>
            <label><input type="radio" name="gst-cli" checked={gstClient === "all"} onChange={() => setGstClient("all")} /> All Client</label>
          </div>
        </fieldset>
        <label><input type="checkbox" checked={dateApply} onChange={(e) => setDateApply(e.target.checked)} /> Date Apply</label>
        <label><input type="checkbox" checked={withSettlement} onChange={(e) => setWithSettlement(e.target.checked)} /> With Settlement</label>
        <label>Similar Name <select className="win" defaultValue="Select"><option>Select</option></select></label>
        <div className="gst-actions">
          <div className="gst-print-cap">Print</div>
          <button type="button" className="fn" onClick={() => void loadBills()}>Small Printer</button>
          <button type="button" className="fn" onClick={() => void loadBills()}>Refresh</button>
          <button type="button" className="fn" onClick={() => void loadTaxSummary()}>Tax Summery Small Print</button>
          <button type="button" className="fn" onClick={() => void exportPdf()}>Export</button>
          <button type="button" className="fn" disabled tabIndex={-1}>Mail</button>
          <button type="button" className="fn" onClick={onExit}>Close</button>
        </div>
      </aside>
      <div className="gst-main">
        {view === "empty" && (
          <div className="gst-stage">
            <table className="gst-empty-grid">
              <thead>
                <tr><th>Column1</th><th>Column2</th></tr>
              </thead>
              <tbody>
                <tr><td colSpan={2}>&nbsp;</td></tr>
              </tbody>
            </table>
          </div>
        )}
        {view === "bills" && (
          <>
            <div className="gst-grid-wrap" ref={gridWrapRef}>
              <table className="gst-bill-grid">
                <thead>
                  <tr>
                    {GST_COLS.map(([k, label]) => <th key={k}>{label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: any, i: number) => (
                    <tr
                      key={String(r.invoice_id || i)}
                      className={i === sel ? "on" : ""}
                      tabIndex={i === sel ? 0 : -1}
                    >
                      {GST_COLS.map(([k, , money]) => (
                        <td key={k} className={money ? "num" : undefined}>
                          {money ? gstAmt(r[k]) : String(r[k] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {!!rows.length && (
                    <tr className="gst-total-row">
                      {GST_COLS.map(([k, , money], i) => (
                        <td key={k} className={money ? "num" : undefined}>
                          {i === 0 ? "" : money ? gstAmt(totals[k]) : ""}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="gst-foot-bar">
              <label>Advance : CA <input className="win" readOnly tabIndex={-1} value={gstAmt(footer.advance)} /></label>
              <label>BANK TRAN.. <input className="win" readOnly tabIndex={-1} value={gstAmt(footer.bank)} /></label>
              <label>CASH <input className="win" readOnly tabIndex={-1} value={gstAmt(footer.cash)} /></label>
              <label>PREPAID C.. <input className="win" readOnly tabIndex={-1} value={gstAmt(footer.prepaid)} /></label>
              <label>Liquor <input className="win" readOnly tabIndex={-1} value={String(Math.round((Number(footer.liquor) || 0) / 100))} /></label>
              <label>Food <input className="win" readOnly tabIndex={-1} value={String(Math.round((Number(footer.food) || 0) / 100))} /></label>
            </div>
          </>
        )}
        {view === "summary" && (
          <div className="gst-summary-view">
            <CrystalChrome
              onExit={onExit}
              onExport={() => void exportPdf()}
              toolsVisible={editTools}
              onToggleTools={() => setEditTools((v) => !v)}
            >
              <div className={`cr-paper gst-paper gst-summery-slip${editTools ? "" : " gst-tools-off"}`}>
                <h1>THE BOSS</h1>
                <h2>GST Summery</h2>
                <div className="cr-meta">From : {fromLabel} &nbsp;&nbsp; To : {toLabel}</div>
                <div className="gst-sum-pair">
                <div className="gst-sum-left">
                <table className="gst-sum gst-sum-tax">
                  <colgroup>
                    <col className="c-lbl" /><col className="c-base" /><col className="c-gap" /><col className="c-amt" />
                  </colgroup>
                  <tbody>
                    <tr><td>Total</td><td colSpan={2} /><td className="num">{gstSumAmt(s.total)}</td></tr>
                    <tr><td>Discount</td><td colSpan={2} /><td className="num">{gstSumAmt(s.discount)}</td></tr>
                    <tr><td>S. Total</td><td colSpan={2} /><td className="num">{gstSumAmt(s.s_total)}</td></tr>
                    <tr><td>Service Charge</td><td colSpan={2} /><td className="num">{gstSumAmt(s.service)}</td></tr>
                    <tr><td>Non GST</td><td colSpan={2} /><td className="num">{gstSumAmt(s.non_gst)}</td></tr>
                    <tr className="gst-sum-head">
                      <td /><td className="ctr">Taxable Value</td><td /><td className="ctr">Tax</td>
                    </tr>
                    <tr>
                      <td>GST 5%</td>
                      <td className="num">{gstSumAmt(s.gst5_base)}</td>
                      <td />
                      <td className="num">{gstSumAmt(s.gst5_tax)}</td>
                    </tr>
                    <tr>
                      <td>GST 18%</td>
                      <td className="num">{gstSumAmt(s.gst18_base)}</td>
                      <td />
                      <td className="num">{gstSumAmt(s.gst18_tax)}</td>
                    </tr>
                    <tr>
                      <td>Vat 20%</td>
                      <td className="num">{gstSumAmt(s.vat20_base)}</td>
                      <td />
                      <td className="num">{gstSumAmt(s.vat20_tax)}</td>
                    </tr>
                    <tr>
                      <td>Surcharge Only</td>
                      <td className="num">{gstSumAmt(s.surcharge20_base)}</td>
                      <td />
                      <td className="num">{gstSumAmt(s.surcharge20_tax)}</td>
                    </tr>
                    <tr><td>Round Off</td><td colSpan={2} /><td className="num">{gstSumAmt(s.round_off)}</td></tr>
                    <tr><td>Total Tax</td><td colSpan={2} /><td className="num">{gstSumAmt(s.total_tax)}</td></tr>
                    <tr><td>Net Amount</td><td colSpan={2} /><td className="num">{gstSumAmt(s.net_amount)}</td></tr>
                  </tbody>
                </table>
                <table className="gst-sum-mop">
                  <thead>
                    <tr><th>Particular</th><th>Amount</th></tr>
                  </thead>
                  <tbody>
                    {particulars.map((p: any) => {
                      const label = String(p.label || "");
                      const slash = label.indexOf(" / ");
                      const dual = slash > 0 && label.startsWith("BANK TRANSFER");
                      return (
                        <tr key={label}>
                          <td className="mop-name">
                            {dual ? (
                              <>
                                <span>{label.slice(0, slash)}</span>
                                <span className="mop-sub">{label.slice(slash)}</span>
                              </>
                            ) : label}
                          </td>
                          <td className="num">{gstSumAmt(p.amount)}</td>
                        </tr>
                      );
                    })}
                    {!particulars.length && (
                      <tr><td className="mop-name">CASH</td><td className="num">0.00</td></tr>
                    )}
                  </tbody>
                </table>
                </div>
                <div className="gst-sum-right">
                <table className="gst-sum-manual">
                  <colgroup>
                    <col className="c-lbl" /><col className="c-amt" />
                  </colgroup>
                  <tbody>
                    {cashLines.map((line) => cashRow(line))}
                    {!hiddenLines.includes("system_cash") && cashRow(systemCash, true)}
                    {extraLines.map((line) => (
                      <tr key={line.id}>
                        <td className="lbl">
                          <textarea
                            id={`gst-xl-${line.id}`}
                            className="win gst-lbl-in"
                            rows={1}
                            wrap="soft"
                            value={line.label}
                            onChange={(e) => { resizeGstLabel(e.currentTarget); putExtra(line.id, { label: e.target.value }); }}
                            ref={resizeGstLabel}
                            onKeyDown={onManualEnter}
                          />
                        </td>
                        <td className="amt-cell">
                          <input
                            className="win gst-amt-in"
                            inputMode="decimal"
                            value={line.amount}
                            onChange={(e) => putExtra(line.id, { amount: amountTyping(e.target.value) })}
                            onBlur={(e) => putExtra(line.id, { amount: formatManualAmt(e.target.value) })}
                            onKeyDown={onManualEnter}
                          />
                          <button type="button" className="fn gst-manual-del" onClick={() => removeExtraLine(line.id)}>X</button>
                        </td>
                      </tr>
                    ))}
                    {cashRow(cashInHand)}
                    <tr className="gst-manual-reset">
                      <td colSpan={2}>
                        {hiddenLines.includes("system_cash") && <button type="button" className="fn gst-manual-plus" onClick={addExtraLine}>+</button>}
                        <button type="button" className="fn" onClick={resetFields}>Reset</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <table className="gst-sum-manual gst-sum-sale">
                  <colgroup>
                    <col className="c-lbl" /><col className="c-amt" />
                  </colgroup>
                  <tbody>
                    <tr>
                      <td className="lbl">
                        System Sale
                        <button type="button" className="fn gst-manual-plus" onClick={addSaleLine}>+</button>
                      </td>
                      <td>
                        <input className="win gst-amt-in" readOnly tabIndex={-1} value={systemSaleAmt} />
                      </td>
                    </tr>
                    {saleLines.map((line) => (
                      <tr key={line.id}>
                        <td className="lbl">
                          <textarea
                            id={`gst-sl-${line.id}`}
                            className="win gst-lbl-in"
                            rows={1}
                            wrap="soft"
                            value={line.label}
                            onChange={(e) => { resizeGstLabel(e.currentTarget); putSaleLine(line.id, { label: e.target.value }); }}
                            ref={resizeGstLabel}
                            onKeyDown={onManualEnter}
                          />
                        </td>
                        <td className="amt-cell">
                          <input
                            className="win gst-amt-in"
                            inputMode="decimal"
                            value={line.amount}
                            onChange={(e) => putSaleLine(line.id, { amount: amountTyping(e.target.value) })}
                            onBlur={(e) => putSaleLine(line.id, { amount: formatManualAmt(e.target.value) })}
                            onKeyDown={onManualEnter}
                          />
                          <button type="button" className="fn gst-manual-del" onClick={() => removeSaleLine(line.id)}>X</button>
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="lbl">Total Sale</td>
                      <td>
                        <input className="win gst-amt-in" readOnly tabIndex={-1} value={totalSaleAmt} />
                      </td>
                    </tr>
                  </tbody>
                </table>
                </div>
                </div>
              </div>
            </CrystalChrome>
            <div className="gst-foot-bar">
              <label>Advance : CA <input className="win" readOnly tabIndex={-1} value={gstAmt(footer.advance)} /></label>
              <label>BANK TRAN.. <input className="win" readOnly tabIndex={-1} value={gstAmt(footer.bank)} /></label>
              <label>CASH <input className="win" readOnly tabIndex={-1} value={gstAmt(footer.cash)} /></label>
              <label>PREPAID C.. <input className="win" readOnly tabIndex={-1} value={gstAmt(footer.prepaid)} /></label>
              <label>Liquor <input className="win" readOnly tabIndex={-1} value={String(Math.round((Number(footer.liquor) || 0) / 100))} /></label>
              <label>Food <input className="win" readOnly tabIndex={-1} value={String(Math.round((Number(footer.food) || 0) / 100))} /></label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ItemWiseSale({ onExit }: { onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [sel, setSel] = useState("BAR");
  const [checked, setChecked] = useState<Record<string, boolean>>({
    BAR: true, CAFE: true, NC: true, RESTAURANT: true, "THE BOSS CLUB": true,
  });
  const [rows, setRows] = useState<any[]>([]);
  const [filters, setFilters] = useState({ salesGroup: "", item: "", itemGroup: "", orderBy: "name", btc: "", waiter: "", mop: "" });
  const [withTax, setWithTax] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    if (!from || !to || from > to) { setError("Please select a valid date range."); return; }
    setBusy(true); setError("");
    try {
      const data = await api.get<any>(`/api/reports/item-wise?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      setRows(data.rows ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load item wise sales."); }
    finally { setBusy(false); }
  }
  useEffect(() => { load().catch(() => null); }, []);
  const options = (key: string) => [...new Set(rows.map((r) => String(r[key] ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const filtered = useMemo(() => rows.filter((r) => {
    const outlet = String(r.outlet_name || "BAR").toUpperCase();
    return !!checked[outlet] && (!filters.salesGroup || r.sales_group === filters.salesGroup)
      && (!filters.item || r.item_name === filters.item) && (!filters.itemGroup || r.item_group === filters.itemGroup)
      && (!filters.btc || String(r.order_card || "") === filters.btc) && (!filters.waiter || r.waiter === filters.waiter)
      && (!filters.mop || String(r.mop || "").split(",").includes(filters.mop));
  }), [rows, checked, filters]);
  const map = new Map<string, { name: string; sold: number; complimentary: number; amount: number; outlet: string; tax: number; unit: string; salesGroup: string; itemGroup: string }>();
  for (const r of filtered) {
    const key = `${r.item_name}\u0000${r.outlet_name}`;
    const cur = map.get(key) || { name: r.item_name, sold: 0, complimentary: 0, amount: 0, outlet: r.outlet_name, tax: r.tax_rate, unit: r.unit || "", salesGroup: r.sales_group || "", itemGroup: r.item_group || "" };
    const qty = Number(r.qty) || 0;
    if (Number(r.amount) === 0) cur.complimentary += qty; else {
      cur.sold += qty;
      const base = Number(r.amount) || 0;
      cur.amount += base + (withTax ? Math.round(base * (Number(r.tax_rate) || 0) / 100) : 0);
    }
    map.set(key, cur);
  }
  const items = [...map.values()].sort((a, b) => filters.orderBy === "amount" ? b.amount - a.amount : filters.orderBy === "qty" ? b.sold - a.sold : a.name.localeCompare(b.name));
  const groups = useMemo(() => {
    const g: Record<string, typeof rows> = {};
    for (const r of items) {
      const key = r.outlet;
      (g[key] ||= []).push(r);
    }
    return g;
  }, [filtered, filters.orderBy, checked, withTax]);
  let sl = 0;
  return (
    <div className="iws-page">
      <div className="rpt-bar wrap">
        <label>Sales Group : <select className="win" value={filters.salesGroup} onChange={(e) => setFilters({ ...filters, salesGroup: e.target.value })}><option value="">Select</option>{options("sales_group").map((v) => <option key={v}>{v}</option>)}</select></label>
        <label>Item Name : <select className="win" value={filters.item} onChange={(e) => setFilters({ ...filters, item: e.target.value })}><option value="">Select</option>{options("item_name").map((v) => <option key={v}>{v}</option>)}</select></label>
        <label>Item Group : <select className="win" value={filters.itemGroup} onChange={(e) => setFilters({ ...filters, itemGroup: e.target.value })}><option value="">Select</option>{options("item_group").map((v) => <option key={v}>{v}</option>)}</select></label>
        <label>Order By : <select className="win" value={filters.orderBy} onChange={(e) => setFilters({ ...filters, orderBy: e.target.value })}><option value="name">Order By Item Name</option><option value="amount">Order By Amount</option><option value="qty">Order By Sold Qty</option></select></label>
        <label>BTC : <select className="win" value={filters.btc} onChange={(e) => setFilters({ ...filters, btc: e.target.value })}><option value="">Select</option>{options("order_card").map((v) => <option key={v}>{v}</option>)}</select></label>
        <label><input type="checkbox" checked={withTax} onChange={(e) => setWithTax(e.target.checked)} /> With Tax</label>
        <label>Waiter : <select className="win" value={filters.waiter} onChange={(e) => setFilters({ ...filters, waiter: e.target.value })}><option value="">Select</option>{options("waiter").map((v) => <option key={v}>{v}</option>)}</select></label>
        <label>MOP : <select className="win" value={filters.mop} onChange={(e) => setFilters({ ...filters, mop: e.target.value })}><option value="">Select</option>{[...new Set(rows.flatMap((r) => String(r.mop || "").split(",").filter(Boolean)))].sort().map((v) => <option key={v}>{v}</option>)}</select></label>
        <label>Card <select className="win" value={filters.mop === "CARD" ? "CARD" : ""} onChange={(e) => setFilters({ ...filters, mop: e.target.value })}><option value="">Select</option><option>CARD</option></select></label>
        <label><input type="checkbox" /> With Out Discount</label>
        <span className="spacer" />
        <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>To</span>
        <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="fn" onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</button>
      </div>
      <div className="iws-body">
        <aside className="pos-tree">
          {["BAR", "CAFE", "NC", "RESTAURANT", "THE BOSS CLUB"].map((o) => (
            <label key={o} className={sel === o ? "on" : ""} onClick={() => setSel(o)}>
              <input type="checkbox" checked={!!checked[o]} onChange={() => setChecked({ ...checked, [o]: !checked[o] })} />
              {o}
            </label>
          ))}
        </aside>
        <div className="iws-grid-wrap">
          <table className="iws-grid">
            <thead>
              <tr>
                <th>SN.</th><th>Item Name</th><th>Complementary</th><th>Sold</th>
                <th>Amount</th><th>Group Total</th><th>Unit</th><th>Sub Unit</th>
              </tr>
            </thead>
            <tbody>
              {error ? <tr><td colSpan={8} className="empty">{error}</td></tr> : !items.length ? <tr><td colSpan={8} className="empty">No sales for the selected date range</td></tr> : Object.entries(groups).flatMap(([gname, items]) => {
                const tot = items.reduce((s, i) => s + i.amount, 0);
                const head = (
                  <tr key={gname} className="grp">
                    <td /><td colSpan={4}>{gname}</td><td className="num">{inr(tot)}</td><td /><td />
                  </tr>
                );
                const body = items.map((it) => {
                  sl += 1;
                  return (
                    <tr key={`${it.name}-${it.outlet}`}>
                      <td>{sl}</td>
                      <td>{it.name.toUpperCase()}</td>
                      <td>{it.complimentary}</td>
                      <td>{it.sold}</td>
                      <td>{inr(it.amount)}</td>
                      <td />
                      <td>{it.unit}</td>
                      <td />
                    </tr>
                  );
                });
                return [head, ...body];
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="rpt-foot">
        <button className="fn" onKeyDown={ignoreRepeatedPrintKey} onClick={printPage}>S.Print</button>
        <button className="fn" onKeyDown={ignoreRepeatedPrintKey} onClick={printPage}>Print</button>
        <button className="fn" onClick={() => { const csv = ["Outlet,Item Name,Complementary,Sold,Amount,Unit", ...items.map((r) => [r.outlet, r.name, r.complimentary, r.sold, (r.amount / 100).toFixed(2), r.unit].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))].join("\n"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = `item-wise-sales-${from}-${to}.csv`; a.click(); URL.revokeObjectURL(a.href); }}>Export</button>
        <button className="fn" onClick={onExit}>Close</button>
      </div>
    </div>
  );
}

function liquorBaseName(value: unknown) {
  return String(value ?? "").trim().toUpperCase()
    .replace(/\s+(?:30\s*ML|750\s*ML|BTL|BOTTLE)\s*$/i, "")
    .replace(/\s+/g, " ").trim();
}

export function ItemWiseGroupSales({ onExit }: { onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [period, setPeriod] = useState<"dates" | "month">("dates");
  const [month, setMonth] = useState(isoDay().slice(0, 7));
  const [startHour, setStartHour] = useState("10");
  const [startMinute, setStartMinute] = useState("00");
  const [startPeriod, setStartPeriod] = useState("AM");
  const [endHour, setEndHour] = useState("2");
  const [endMinute, setEndMinute] = useState("00");
  const [endPeriod, setEndPeriod] = useState("PM");
  const [sort, setSort] = useState<"high" | "low">("high");
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saleTime = (hour: string, minute: string, ap: string) => ((Number(hour) % 12) + (ap === "PM" ? 12 : 0)) * 60 + Number(minute);
  const startTime = saleTime(startHour, startMinute, startPeriod);
  const endTime = saleTime(endHour, endMinute, endPeriod);
  const minuteOptions = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
  async function load() {
    const queryFrom = period === "month" && month ? `${month}-01` : from;
    const queryTo = period === "month" && month ? `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, "0")}` : to;
    if (!queryFrom || !queryTo || queryFrom > queryTo) { setError("Please select a valid date range."); return; }
    setBusy(true); setError("");
    try {
      const data = await api.get<any>(`/api/reports/item-wise?from=${encodeURIComponent(queryFrom)}&to=${encodeURIComponent(queryTo)}`);
      setRows(data.rows ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load item wise group sales."); }
    finally { setBusy(false); }
  }
  useEffect(() => { load().catch(() => null); }, []);
  const grouped = new Map<string, { name: string; bottleEq: number; amount: number; complimentaryEq: number }>();
  for (const row of rows) {
    const timestamp = new Date(String(row.sale_at ?? row.kot_at ?? ""));
    if (Number.isNaN(timestamp.getTime())) continue;
    const clockMinutes = timestamp.getHours() * 60 + timestamp.getMinutes();
    const inTimeWindow = startTime <= endTime
      ? clockMinutes >= startTime && clockMinutes <= endTime
      : clockMinutes >= startTime || clockMinutes <= endTime;
    if (!inTimeWindow) continue;
    const name = liquorBaseName(row.item_name);
    const item = String(row.item_name ?? "").trim().toUpperCase();
    const qty = Number(row.qty) || 0;
    const isShot = /\b30\s*ML\b/.test(item);
    const isBottle = /\b(?:BTL|BOTTLE|750\s*ML)\b/.test(item);
    if (!name || (!isShot && !isBottle)) continue;
    const factor = isShot ? 30 / 750 : 1;
    const cur = grouped.get(name) ?? { name, bottleEq: 0, amount: 0, complimentaryEq: 0 };
    if (Number(row.amount) === 0) cur.complimentaryEq += qty * factor;
    else { cur.bottleEq += qty * factor; cur.amount += Number(row.amount) || 0; }
    grouped.set(name, cur);
  }
  const items = [...grouped.values()].sort((a, b) => sort === "high" ? b.bottleEq - a.bottleEq : a.bottleEq - b.bottleEq);
  const fmt = (n: number) => Number(n.toFixed(3)).toString();
  return <div className="iws-page">
    <div className="rpt-bar wrap">
      <b>Item Wise Group Sales Report</b>
      <label>Period <select className="win" value={period} onChange={(e) => setPeriod(e.target.value as "dates" | "month")}><option value="dates">Date Range</option><option value="month">Month</option></select></label>
      {period === "month" ? <label>Month <input className="win" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label> : <><label>From <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>To <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></>}
      <label>Start <select className="win" value={startHour} onChange={(e) => setStartHour(e.target.value)}>{Array.from({ length: 12 }, (_, i) => String(i + 1)).map((v) => <option key={v}>{v}</option>)}</select> : <select className="win" value={startMinute} onChange={(e) => setStartMinute(e.target.value)}>{minuteOptions.map((v) => <option key={v}>{v}</option>)}</select> <select className="win" value={startPeriod} onChange={(e) => setStartPeriod(e.target.value)}><option>AM</option><option>PM</option></select></label>
      <label>End <select className="win" value={endHour} onChange={(e) => setEndHour(e.target.value)}>{Array.from({ length: 12 }, (_, i) => String(i + 1)).map((v) => <option key={v}>{v}</option>)}</select> : <select className="win" value={endMinute} onChange={(e) => setEndMinute(e.target.value)}>{minuteOptions.map((v) => <option key={v}>{v}</option>)}</select> <select className="win" value={endPeriod} onChange={(e) => setEndPeriod(e.target.value)}><option>AM</option><option>PM</option></select></label>
      <label>Sales <select className="win" value={sort} onChange={(e) => setSort(e.target.value as "high" | "low")}><option value="high">High to Low</option><option value="low">Low to High</option></select></label>
      <button className="fn" onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</button>
    </div>
    <div className="iws-grid-wrap">
      <table className="iws-grid"><thead><tr><th>SN.</th><th>Item Name</th><th>Complimentary (BTL)</th><th>Sold (BTL Equivalent)</th><th>Amount</th></tr></thead>
        <tbody>{error ? <tr><td colSpan={5} className="empty">{error}</td></tr> : items.length ? items.map((it, i) => <tr key={it.name}><td>{i + 1}</td><td>{it.name}</td><td>{fmt(it.complimentaryEq)}</td><td>{fmt(it.bottleEq)}</td><td>{inr(it.amount)}</td></tr>) : <tr><td colSpan={5} className="empty">No matching 30 ml or bottle sales in this range</td></tr>}</tbody>
      </table>
    </div>
    <div className="rpt-foot"><span>30 ml = 1/25 bottle; BTL = 1 bottle (750 ml). Time filter uses local sale time.</span><span className="spacer" /><button className="fn" onClick={onExit}>Close</button></div>
  </div>;
}

export function GridReport({ title, endpoint, columns, onExit, onEdit, cellSelect }: {
  title: string; endpoint: string; columns: Array<[string, string]>; onExit: () => void;
  onEdit?: (row: any) => void;
  cellSelect?: boolean;
}) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [rows, setRows] = useState<any[]>([]);
  const [sel, setSel] = useState(0);
  const [col, setCol] = useState(0);
  const selRef = useRef(0);
  const rowsRef = useRef(rows);
  const onEditRef = useRef(onEdit);
  selRef.current = sel;
  rowsRef.current = rows;
  onEditRef.current = onEdit;
  useLayoutEffect(() => {
    if (!rows.length || sel !== rows.length - 1) return;
    const scroller = document.querySelector(".rpt-page .grid-fill") as HTMLElement | null;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    const tr = scroller.querySelector("tbody tr:last-child") as HTMLElement | null;
    tr?.focus({ preventScroll: true });
  }, [rows, sel]);
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (document.querySelector(".su-dlg, .alert-dlg, .confirm-dlg, .kot-view")) return;
      if (!rows.length) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (cellSelect && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowLeft") setCol((c) => Math.max(0, c - 1));
        if (e.key === "ArrowRight") setCol((c) => Math.min(columns.length - 1, c + 1));
        if (e.key === "ArrowDown") setSel((i) => Math.min(rows.length - 1, i + 1));
        if (e.key === "ArrowUp") setSel((i) => Math.max(0, i - 1));
        requestAnimationFrame(() => document.querySelector("table.data td.cell-on")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
        return;
      }
      if (cellSelect && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const row = rowsRef.current[selRef.current];
        if (row) onEditRef.current?.(row);
        return;
      }
      if (tag === "BUTTON") return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((i) => {
          const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
          requestAnimationFrame(() => document.querySelector("table.data tbody tr.on")?.scrollIntoView({ block: "nearest" }));
          return next;
        });
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = rows[sel];
        if (row) onEdit?.(row);
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });
  async function load() {
    const join = endpoint.includes("?") ? "&" : "?";
    const data = await api.get<any>(endpoint.includes("/inventory") ? endpoint : `${endpoint}${join}from=${from}&to=${to}`);
    const next = Array.isArray(data) ? data : (data.rows ?? []);
    setRows(next);
    setSel(Math.max(0, next.length - 1));
    setCol(0);
  }
  useEffect(() => { load().catch(() => null); }, []);
  return (
    <div className="rpt-page plain">
      <div className="rpt-bar">
        <b>{title}</b>
        <FilterDates from={from} to={to} setFrom={setFrom} setTo={setTo} onShow={load} />
        <button className="fn" onClick={onExit}>Exit</button>
      </div>
      <div className="grid-fill">
        <table className="data">
          <thead><tr>{columns.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={i}
                className={!cellSelect && i === sel ? "on" : ""}
                tabIndex={0}
                onClick={(e) => {
                  const td = (e.target as HTMLElement).closest("td");
                  const c = td ? Math.max(0, [...td.parentElement!.children].indexOf(td)) : 0;
                  setSel(i);
                  setCol(c);
                  if (!cellSelect) onEdit?.(r);
                }}
                onDoubleClick={() => {
                  setSel(i);
                  onEdit?.(r);
                }}
                onKeyDown={cellSelect ? undefined : (e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  setSel(i);
                  onEdit?.(r);
                }}
              >
                {columns.map(([k], c) => (
                  <td key={k} className={cellSelect && i === sel && c === col ? "cell-on" : ""}>
                    {typeof r[k] === "number" && (k.includes("total") || k === "grand_total" || k === "amount") ? inr(r[k]) : String(r[k] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={columns.length} className="empty">No records</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SETTLE_ACCOUNTS = [
  "Select", "Bank payment", "BOOK MY SHOW", "COUPON", "DINEOUT", "DISTRICT",
  "EAZYDINNER", "HDFC", "PAYTM", "ZOMATO", "PARTYPAL", "INDUS", "MOBIKWIK",
];

const BANK_ACCOUNTS = SETTLE_ACCOUNTS.filter((a) => a !== "Select");
const ADVANCE_MOPS = ["CASH", "BANK TRANSFER"] as const;

function mopName(method?: string) {
  if (method === "CASH") return "CASH";
  if (method === "MEMBER_CARD") return "PREPAID CARD";
  if (method === "CARD" || method === "UPI") return "BANK TRANSFER";
  return method || "";
}

function modeLabel(method?: string) {
  if (method === "MEMBER_CARD") return "PREPAID CARD";
  if (method === "CARD" || method === "UPI") return "BANK TRANSFER";
  return "CASH";
}

function mopCell(method?: string, account?: string) {
  const mode = mopName(method);
  const acct = method === "CASH" ? (account || "Cash").replace(/\.$/, "") : account || "";
  return acct ? `${mode} (${acct})` : mode;
}

function clock(d: Date) {
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return { h, ap };
}

function stampGrid(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const { h, ap } = clock(d);
  return `${pad(d.getDate())}/${MONTHS[d.getMonth()]}/${d.getFullYear()} ${h}:${pad(d.getMinutes())} ${ap}`;
}

function stampDialog(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const { h, ap } = clock(d);
  return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad(h)}:${pad(d.getMinutes())} ${ap}`;
}

const REPORT_PAY_MODES = ["CASH", "BANK TRANSFER", "PREPAID CARD"] as const;

function amountText(value: string) {
  const clean = value.replace(/[^\d.]/g, "");
  const dot = clean.indexOf(".");
  if (dot < 0) return clean;
  return clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, "");
}

type SettlementPart = { method: string; amount: number; account: string; remark: string };

function SettlementUpdateDialog({
  paymentId,
  outlet,
  onClose,
  onChanged,
}: {
  paymentId: string;
  outlet: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [row, setRow] = useState<any>(null);
  const [mode, setMode] = useState("CASH");
  const [amount, setAmount] = useState("");
  const [bankName, setBankName] = useState(BANK_ACCOUNTS[0]);
  const [parts, setParts] = useState<SettlementPart[]>([]);
  const busy = useRef(false);
  const [remark, setRemark] = useState("");
  const [warn, setWarn] = useState("");
  const [askDelete, setAskDelete] = useState(false);
  const warnBack = useRef<"amount" | "mode" | "bank" | "save" | "remark">("amount");
  const amtRef = useRef<HTMLInputElement>(null);
  const remarkRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<HTMLSelectElement>(null);
  const bankRef = useRef<HTMLSelectElement>(null);
  const updateRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  function focusField(where: "amount" | "mode" | "bank" | "save" | "remark") {
    if (where === "amount") {
      amtRef.current?.focus();
      amtRef.current?.select();
    } else if (where === "mode") modeRef.current?.focus();
    else if (where === "bank") bankRef.current?.focus();
    else if (where === "remark") {
      remarkRef.current?.focus();
      remarkRef.current?.select();
    } else updateRef.current?.focus();
  }

  function showWarn(message: string, back: "amount" | "mode" | "bank" | "save" | "remark") {
    warnBack.current = back;
    setWarn(message);
  }

  function applyRow(next: any) {
    const label = modeLabel(next.method);
    const bank = label === "BANK TRANSFER" && BANK_ACCOUNTS.includes(next.account) ? next.account : BANK_ACCOUNTS[0];
    setRow(next);
    setMode(label);
    setAmount(rupees(next.amount));
    setBankName(bank);
    setRemark(next.remark || "");
  }

  useEffect(() => {
    let gone = false;
    api.get<any>(`/api/reports/settlement/${paymentId}`).then((next) => {
      if (gone) return;
      applyRow(next);
      setWarn("");
      setTimeout(() => { amtRef.current?.focus(); amtRef.current?.select(); }, 0);
    }).catch((e) => { if (!gone) showWarn(e.message, "amount"); });
    return () => { gone = true; };
  }, [paymentId]);

  const remaining = (row?.amount ?? 0) - parts.reduce((sum, part) => sum + part.amount, 0);
  const prepaid = row?.method === "MEMBER_CARD";

  async function save() {
    if (!row || busy.current || warn || askDelete) return;
    let paise = 0;
    try { paise = parseRupeesInput(amount || "0"); } catch { showWarn("Enter settle amount", "amount"); return; }
    if (paise <= 0) { showWarn("Enter settle amount", "amount"); return; }
    if (paise > remaining) { showWarn("Amount exceeds the remaining settlement", "amount"); return; }
    if (prepaid && paise !== remaining) { showWarn("Prepaid card settlements cannot be split", "amount"); return; }
    const account = mode === "BANK TRANSFER" ? bankName : mode === "CASH" ? "Cash." : row.account;
    const lines = [...parts, { method: mode, amount: paise, account, remark }];
    if (paise < remaining) {
      setParts(lines);
      setAmount(rupees(remaining - paise));
      setMode(REPORT_PAY_MODES[0]);
      setBankName(BANK_ACCOUNTS[0]);
      setRemark(row.remark || "");
      window.setTimeout(() => focusField("amount"), 0);
      return;
    }
    busy.current = true;
    const original = { method: row.method, amount: row.amount, account: row.account, remark: row.remark };
    try {
      await api.put(`/api/reports/settlement/${paymentId}`, { original, lines });
      onChanged();
      onClose();
    } catch (e) {
      showWarn(e instanceof Error ? e.message : "Could not update settlement", "save");
    } finally {
      busy.current = false;
    }
  }

  async function remove() {
    if (busy.current || parts.length) return;
    busy.current = true;
    setAskDelete(false);
    try {
      await api.del(`/api/reports/settlement/${paymentId}`);
      onChanged();
      onClose();
    } catch (e) {
      showWarn(e instanceof Error ? e.message : "Delete failed", "save");
    } finally {
      busy.current = false;
    }
  }

  useEffect(() => {
    function keys(e: globalThis.KeyboardEvent) {
      if (warn || askDelete || document.querySelector(".confirm-dlg, .alert-dlg")) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (!busy.current) close.current(); return; }
      if (e.key === "F2") { e.preventDefault(); e.stopImmediatePropagation(); void save(); return; }
      if (e.key === "F4") { e.preventDefault(); e.stopImmediatePropagation(); if (!busy.current && !parts.length) setAskDelete(true); return; }
      const active = document.activeElement;
      if (e.key !== "Enter") return;
      if (active === amtRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        modeRef.current?.focus();
      } else if (active === modeRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (mode === "BANK TRANSFER") bankRef.current?.focus();
        else updateRef.current?.focus();
      } else if (active === bankRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        updateRef.current?.focus();
      } else if (active === remarkRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        updateRef.current?.focus();
      } else if (active === updateRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void save();
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  return (
    <div className="dialog settle-dlg su-dlg">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Restaurant Settlement - {outlet}
        <CapBtns onClose={() => { if (!busy.current) onClose(); }} />
      </div>
      <div className="settle-body">
        <table className="st-form">
          <colgroup>
            <col className="l" /><col /><col className="l" /><col />
          </colgroup>
          <tbody>
            <tr>
              <td className="lbl">Bill No. :</td>
              <td><input className="win" readOnly tabIndex={-1} value={row?.bill_no ?? ""} /></td>
              <td className="lbl">Date :</td>
              <td><input className="win" readOnly tabIndex={-1} value={stampDialog(row?.voucher_date)} /></td>
            </tr>
            <tr>
              <td className="lbl">Guest Name :</td>
              <td><input className="win" readOnly tabIndex={-1} value={row?.guest || ""} /></td>
              <td className="lbl">Table No :</td>
              <td><input className="win" readOnly tabIndex={-1} value={row?.table_no || ""} /></td>
            </tr>
            <tr>
              <td className="lbl">Voucher/Receipt :</td>
              <td><input className="win" readOnly tabIndex={-1} value={row?.receipt_no ?? ""} /></td>
              <td className="lbl">Bill Amount :</td>
              <td><input className="win num" readOnly tabIndex={-1} value={rupees(row?.bill_amount)} /></td>
            </tr>
            <tr>
              <td className="lbl">Allowance :</td>
              <td><input className="win num" readOnly tabIndex={-1} value={rupees(row?.allowance)} /></td>
              <td className="lbl">Payment Mode :</td>
              <td>
                <select ref={modeRef} className="win" tabIndex={2} value={mode} onChange={(e) => setMode(e.target.value)}>
                  {REPORT_PAY_MODES.filter((choice) => prepaid === (choice === "PREPAID CARD")).map((choice) => <option key={choice}>{choice}</option>)}
                </select>
              </td>
            </tr>
            {mode === "BANK TRANSFER" && (
              <tr>
                <td /><td />
                <td className="lbl">Bank Name :</td>
                <td>
                  <select ref={bankRef} className="win" tabIndex={3} value={bankName} onChange={(e) => setBankName(e.target.value)}>
                    {BANK_ACCOUNTS.map((name) => <option key={name}>{name}</option>)}
                  </select>
                </td>
              </tr>
            )}
            <tr>
              <td className="lbl">Payment Amount :</td>
              <td>
                <input
                  ref={amtRef}
                  className="win green num"
                  data-num="dec"
                  tabIndex={1}
                  readOnly={prepaid}
                  autoFocus
                  value={amount}
                  onChange={(e) => setAmount(amountText(e.target.value))}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </td>
              <td className="lbl">Remaining Amount :</td>
              <td><input className="win num" readOnly tabIndex={-1} value={rupees(remaining)} /></td>
            </tr>
            <tr>
              <td className="lbl">Remark :</td>
              <td colSpan={3}><input ref={remarkRef} className="win" tabIndex={-1} value={remark} onChange={(e) => setRemark(e.target.value)} /></td>
            </tr>
          </tbody>
        </table>
        {parts.length > 0 && (
          <ol aria-label="Payment parts entered">
            {parts.map((part, index) => <li key={index}>{part.method}{part.method === "BANK TRANSFER" ? ` (${part.account})` : ""} {inr(part.amount)}</li>)}
          </ol>
        )}
        <div className="st-foot">
          <span className="st-vno">Voucher No : {row?.voucher_no ?? ""}</span>
          <button type="button" className="fn" tabIndex={-1} onKeyDown={ignoreRepeatedPrintKey} onClick={() => {
            if (row?.invoice_id) void printBill(row.invoice_id).catch(() => null);
          }}>Print</button>
          <button ref={updateRef} type="button" className="fn" tabIndex={4} onClick={() => void save()}>{parts.length ? "Post (F2)" : "Update (F2)"}</button>
          <button type="button" className="fn" tabIndex={-1} disabled={parts.length > 0} onClick={() => setAskDelete(true)}>Delete (F4)</button>
          <button type="button" className="fn" tabIndex={-1} onClick={() => { if (!busy.current) onClose(); }}>{parts.length ? "Discard" : "Exit"}</button>
        </div>
      </div>
      {warn && (
        <AlertBox
          message={warn}
          onClose={() => {
            const back = warnBack.current;
            setWarn("");
            window.setTimeout(() => focusField(back), 0);
          }}
        />
      )}
      {askDelete && (
        <ConfirmAsk message="Delete this settlement?" onYes={() => void remove()} onNo={() => setAskDelete(false)} />
      )}
    </div>
  );
}

const SETTLEMENT_COLUMNS = [
  "VoucherRecei", "VoucherDate", "BillNo", "BillAmount", "TableNo", "Waiter",
  "SettledAmou", "MOP", "USERNAME", "VoucherValu", "status", "OutletName", "MOP1",
];

type SettlementRow = {
  payment_id: string;
  receipt_no?: string;
  voucher_date: string;
  bill_no?: string;
  bill_amount: number;
  table_no?: string;
  waiter?: string;
  settled: number;
  method?: string;
  account?: string;
  username?: string;
  status?: string;
  outlet_name?: string;
};

const compareSettlementMop = (a: SettlementRow, b: SettlementRow) =>
  mopCell(a.method, a.account).localeCompare(mopCell(b.method, b.account));
const compareSettlementAmount = (a: SettlementRow, b: SettlementRow) => a.settled - b.settled;
const SETTLEMENT_SORT: Partial<Record<string, (a: SettlementRow, b: SettlementRow) => number>> = {
  VoucherDate: (a, b) => new Date(a.voucher_date).getTime() - new Date(b.voucher_date).getTime(),
  BillAmount: (a, b) => a.bill_amount - b.bill_amount,
  SettledAmou: compareSettlementAmount,
  VoucherValu: compareSettlementAmount,
  MOP: compareSettlementMop,
  MOP1: compareSettlementMop,
};

export function SettlementReport({ outlet, onExit }: { outlet?: string; onExit: () => void }) {
  const request = useReportRequest();
  const usersRequest = useReportRequest();
  const [users, setUsers] = useState<string[]>([]);
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [outletName, setOutletName] = useState(outlet || "THE BOSS CLUB");
  const [mop, setMop] = useState("Select");
  const [bill, setBill] = useState("");
  const [account, setAccount] = useState("Select");
  const [user, setUser] = useState("Select");
  const [settled, setSettled] = useState(false);
  const [data, setData] = useState<{ rows: SettlementRow[]; totals: { method: string; amount: number }[]; allowance: number }>({
    rows: [], totals: [], allowance: 0,
  });
  const [sort, setSort] = useState<{ column: string; direction: "ascending" | "descending" }>();
  const rows = useMemo(() => {
    if (!sort) return data.rows;
    const compare = SETTLEMENT_SORT[sort.column];
    if (!compare) return data.rows;
    const direction = sort.direction === "ascending" ? 1 : -1;
    return [...data.rows].sort((a, b) => direction * compare(a, b));
  }, [data.rows, sort]);
  const appliedPath = useRef("");
  const [sel, setSel] = useState<string | null>(null);
  const [col, setCol] = useState(0);
  const [editId, setEditId] = useState<string | null>(null);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  useEffect(() => { setOutletName(outlet || "THE BOSS CLUB"); }, [outlet]);
  useEffect(() => { void usersRequest.load("/api/reports/settlement/users", setUsers); }, []);

  function show() {
    const q = new URLSearchParams({
      from, to, outlet: outletName, mop, bill, account, user, settled: settled ? "1" : "0",
    });
    appliedPath.current = `/api/reports/settlement?${q}`;
    void request.load(appliedPath.current, setData);
  }
  useEffect(() => {
    if (!rows.length) { setSel(null); return; }
    setSel(rows[rows.length - 1].payment_id);
    setCol(0);
  }, [rows]);
  useLayoutEffect(() => {
    if (!rows.length || sel !== rows[rows.length - 1].payment_id) return;
    if (document.activeElement?.matches(".set-sort")) return;
    const scroller = document.querySelector(".set-grid-wrap") as HTMLElement | null;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    const tr = scroller.querySelector("tbody tr:last-child") as HTMLElement | null;
    tr?.focus({ preventScroll: true });
  }, [rows, sel]);
  useEffect(() => {
    function keys(e: globalThis.KeyboardEvent) {
      if (editId || document.querySelector(".su-dlg, .alert-dlg, .confirm-dlg")) return;
      if (e.target instanceof Element && e.target.closest("button, input, select")) return;
      if (!rows.length) return;
      const idx = Math.max(0, rows.findIndex((r) => r.payment_id === selRef.current));
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowLeft") setCol((c) => Math.max(0, c - 1));
        if (e.key === "ArrowRight") setCol((c) => Math.min(SETTLEMENT_COLUMNS.length - 1, c + 1));
        if (e.key === "ArrowDown") setSel(rows[Math.min(rows.length - 1, idx + 1)].payment_id);
        if (e.key === "ArrowUp") setSel(rows[Math.max(0, idx - 1)].payment_id);
        requestAnimationFrame(() => document.querySelector(".set-table td.cell-on")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const id = selRef.current;
        if (id) setEditId(id);
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  const tot = (m: string) => data.totals.find((t) => t.method === m)?.amount || 0;
  const bank = tot("CARD") + tot("UPI");
  const grand = tot("CASH") + bank + tot("MEMBER_CARD");

  return (
    <div className="set-page">
      <ReportLoadStatus loading={request.loading} error={request.error} />
      {usersRequest.error && <div className="report-load-status" role="alert">Could not load settlement users. {usersRequest.error}</div>}
      <div className="set-filter">
        <div className="set-fields">
          <div className="set-title">Select Filter</div>
          <div className="set-row">
            <label>Outlet : <select className="win" value={outletName} onChange={(e) => setOutletName(e.target.value)}>
              {OUTLETS.map((o) => <option key={o}>{o}</option>)}
            </select></label>
            <label>Date From : <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>MOP : <select className="win" value={mop} onChange={(e) => setMop(e.target.value)}>
              <option>Select</option><option>CASH</option><option>BANK TRANSFER</option><option>PREPAID CARD</option>
            </select></label>
          </div>
          <div className="set-row">
            <label>Bill No. : <input className="win" value={bill} onChange={(e) => setBill(e.target.value)} /></label>
            <label>To Date : <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <label>Accounts : <select className="win" value={account} onChange={(e) => setAccount(e.target.value)}>
              {SETTLE_ACCOUNTS.map((a) => <option key={a}>{a}</option>)}
            </select></label>
          </div>
          <div className="set-row">
            <label>User : <select className="win" value={user} onChange={(e) => setUser(e.target.value)}>
              <option value="Select">{usersRequest.loading ? "Loading users…" : "All users"}</option>
              {users.map((name) => <option key={name}>{name}</option>)}
            </select></label>
            <label className="set-check"><input type="checkbox" checked={settled} onChange={(e) => setSettled(e.target.checked)} /> Settlement</label>
          </div>
        </div>
        <div className="set-btns">
          <button className="fn" onClick={show}>Show</button>
          <button className="fn" onKeyDown={ignoreRepeatedPrintKey} onClick={printPage}>Print</button>
          <button className="fn" onClick={onExit}>Exit</button>
        </div>
      </div>
      <div className="set-grid-wrap">
        <table className="data set-table">
          <thead>
            <tr>
              {SETTLEMENT_COLUMNS.map((column) => {
                if (!SETTLEMENT_SORT[column]) return <th key={column}>{column}</th>;
                const direction = sort?.column === column ? sort.direction : undefined;
                return (
                  <th key={column} aria-sort={direction}>
                    <button
                      type="button"
                      className="set-sort"
                      onClick={() => setSort((current) => ({
                        column,
                        direction: current?.column === column && current.direction === "ascending" ? "descending" : "ascending",
                      }))}
                    >
                      {column} <span aria-hidden="true">{direction === "ascending" ? "▲" : direction === "descending" ? "▼" : "↕"}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mode = mopCell(r.method, r.account);
              const cells = [
                r.receipt_no ?? "", stampGrid(r.voucher_date), r.bill_no ?? "",
                inr(r.bill_amount), r.table_no ?? "", r.waiter ?? "", inr(r.settled),
                mode, r.username ?? "", inr(r.settled), r.status ?? "", r.outlet_name || outletName, mode,
              ];
              const on = r.payment_id === sel;
              return (
                <tr
                  key={r.payment_id}
                  tabIndex={0}
                  onClick={(e) => {
                    const td = (e.target as HTMLElement).closest("td");
                    const c = td ? Math.max(0, [...td.parentElement!.children].indexOf(td)) : 0;
                    setSel(r.payment_id);
                    setCol(c);
                    setEditId(r.payment_id);
                  }}
                >
                  {cells.map((text, c) => (
                    <td key={c} className={`${[3, 6, 9].includes(c) ? "num" : ""} ${on && c === col ? "cell-on" : ""}`.trim()}>
                      {text}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="set-totals">
        <label>Total Cash : <input className="win" readOnly value={rupees(tot("CASH"))} /></label>
        <label>Cheque/D.D. : <input className="win" readOnly value="0.00" /></label>
        <label>Credit Card : <input className="win" readOnly value="0.00" /></label>
        <label>B.T.C. : <input className="win" readOnly value="0.00" /></label>
        <label>Room Credit : <input className="win" readOnly value="0.00" /></label>
        <label>Bank Transfer : <input className="win" readOnly value={rupees(bank)} /></label>
        <label>Wallet : <input className="win" readOnly value="0.00" /></label>
        <label>Allowance : <input className="win" readOnly value={rupees(data.allowance)} /></label>
        <label>Prepaid Card : <input className="win" readOnly value={rupees(tot("MEMBER_CARD"))} /></label>
        <label>Total Amount : <input className="win" readOnly value={rupees(grand)} /></label>
      </div>
      {editId && (
        <SettlementUpdateDialog
          paymentId={editId}
          outlet={outletName}
          onClose={() => setEditId(null)}
          onChanged={() => { void request.load(appliedPath.current, setData); }}
        />
      )}
    </div>
  );
}

export function CardBlock({ onExit }: { onExit: () => void }) {
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [askExit, setAskExit] = useState(false);
  const cardRef = useRef<HTMLInputElement>(null);
  const [blocked, setBlocked] = useState<{ id: string; card_number: string; customer_name: string; block_reason: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function loadBlocked() {
    try {
      setBlocked(await api.get<typeof blocked>("/api/cards/blocked"));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not load blocked cards");
    }
  }

  useEffect(() => { void loadBlocked(); }, []);

  function requestExit() {
    if (q.trim()) setAskExit(true);
    else onExit();
  }
  useEffect(() => {
    function keys(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (askExit || document.querySelector(".alert-dlg")) return;
      e.preventDefault();
      e.stopPropagation();
      requestExit();
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });
  async function block() {
    if (busy) return;
    const number = cardNoDigits(q);
    if (!cardNoReady(number)) { stayOnCard(cardRef.current); return; }
    setBusy(true);
    try {
      const [card] = await api.get<typeof blocked>(`/api/cards?q=${encodeURIComponent(number)}&exact=1`);
      if (!card) { setMsg("Card not found"); return; }
      await api.post(`/api/cards/${card.id}/block`, { reason: "Customer request" });
      await loadBlocked();
      setQ("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not block card");
    } finally {
      setBusy(false);
    }
  }

  async function unblock(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/cards/${id}/unblock`, { reason: "Unblocked from Card Block" });
      await loadBlocked();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not unblock card");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card-block">
      <div className="cb-head">Enter Card No.</div>
      <input ref={cardRef} className="win cb-input" data-num="card" inputMode="numeric" maxLength={4} value={q} onChange={(e) => setQ(cardNoDigits(e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void block(); } }} onBlur={() => { if (q && !cardNoReady(q)) stayOnCard(cardRef.current); }} />
      <div className="cb-btns">
        <button className="fn" disabled={busy} onClick={block}>Block Card</button>
        <button className="fn" onClick={requestExit}>Exit</button>
      </div>
      <div className="set-grid-wrap">
        <table className="data">
          <thead><tr><th>Blocked Card No.</th><th>Customer</th><th>Reason</th><th /></tr></thead>
          <tbody>
            {blocked.map((card) => (
              <tr key={card.id}>
                <td>{card.card_number}</td>
                <td>{card.customer_name}</td>
                <td>{card.block_reason}</td>
                <td><button className="fn" disabled={busy} onClick={() => void unblock(card.id)}>Unblock</button></td>
              </tr>
            ))}
            {!blocked.length && <tr><td colSpan={4}>No blocked cards</td></tr>}
          </tbody>
        </table>
      </div>
      {askExit && <ConfirmAsk message="Exit without save?" onYes={onExit} onNo={() => setAskExit(false)} />}
      {msg && <AlertBox message={msg} onClose={() => setMsg("")} />}
    </div>
  );
}

export function AdvanceBooking({ onExit }: { onExit: () => void }) {
  const blank = { guestName: "", cardNo: "", advance: "0.00", mop: "CASH" };
  const [form, setForm] = useState(blank);
  const [bankName, setBankName] = useState(BANK_ACCOUNTS[0]);
  const [no, setNo] = useState(430);
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState(false);
  const [askExit, setAskExit] = useState(false);
  const guestRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLInputElement>(null);
  const advanceRef = useRef<HTMLInputElement>(null);
  const mopRef = useRef<HTMLInputElement>(null);
  const bankRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const mopValueRef = useRef("CASH");
  const bankValueRef = useRef(BANK_ACCOUNTS[0]);

  useEffect(() => {
    guestRef.current?.focus();
    api.get<any[]>("/api/bookings").then((rows) => {
      const max = rows.reduce((m, r) => Math.max(m, r.reservation_no || 0), 429);
      setNo(max + 1);
    }).catch(() => null);
  }, []);

  function fail(text: string, el?: HTMLInputElement | HTMLSelectElement | HTMLButtonElement | null, select = false) {
    setMsg(text);
    el?.focus();
    if (select && el && "select" in el) el.select();
    return false;
  }

  function advanceValue() {
    const n = Number(form.advance);
    return Number.isFinite(n) ? n : 0;
  }

  function formatAdvance(raw = form.advance) {
    const n = Number(raw);
    return Number.isFinite(n) ? n.toFixed(2) : "0.00";
  }

  function checkGuest() {
    if (!form.guestName.trim()) return fail("Enter Guest Name", guestRef.current, true);
    return true;
  }
  function checkCard() {
    if (!cardNoReady(form.cardNo)) {
      stayOnCard(cardRef.current);
      return false;
    }
    return true;
  }
  function checkAdvance() {
    const n = advanceValue();
    if (!(n > 100)) return fail("Advance must be greater than 100.00", advanceRef.current, true);
    return true;
  }

  function onEnter(guard: () => boolean, next: () => void) {
    return (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      if (!guard()) return;
      setMsg("");
      next();
    };
  }

  function chooseMop(next: string) {
    mopValueRef.current = next;
    setForm((f) => ({ ...f, mop: next }));
    if (next === "BANK TRANSFER" && !BANK_ACCOUNTS.includes(bankValueRef.current)) {
      bankValueRef.current = BANK_ACCOUNTS[0];
      setBankName(BANK_ACCOUNTS[0]);
    }
  }

  function stepMop(dir: 1 | -1) {
    const i = ADVANCE_MOPS.indexOf(mopValueRef.current as (typeof ADVANCE_MOPS)[number]);
    const next = ADVANCE_MOPS[Math.max(0, Math.min(ADVANCE_MOPS.length - 1, (i < 0 ? 0 : i) + dir))];
    if (next && next !== mopValueRef.current) chooseMop(next);
  }

  function stepBank(dir: 1 | -1) {
    const i = Math.max(0, BANK_ACCOUNTS.indexOf(bankValueRef.current));
    const next = BANK_ACCOUNTS[Math.max(0, Math.min(BANK_ACCOUNTS.length - 1, i + dir))];
    if (!next || next === bankValueRef.current) return;
    bankValueRef.current = next;
    setBankName(next);
  }

  function afterMop() {
    if (mopValueRef.current === "BANK TRANSFER") window.setTimeout(() => bankRef.current?.focus(), 0);
    else window.setTimeout(() => saveRef.current?.focus(), 0);
  }

  function resetPay() {
    mopValueRef.current = "CASH";
    bankValueRef.current = BANK_ACCOUNTS[0];
    setBankName(BANK_ACCOUNTS[0]);
  }

  function setAdvance(raw: string) {
    let s = raw.replace(/[^\d.]/g, "");
    const first = s.indexOf(".");
    if (first >= 0) s = s.slice(0, first + 1) + s.slice(first + 1).replace(/\./g, "");
    const [w, d] = s.split(".");
    s = d != null ? `${w}.${d.slice(0, 2)}` : w;
    setForm({ ...form, advance: s });
  }

  async function save() {
    if (!checkGuest() || !checkCard() || !checkAdvance()) return;
    if (mopValueRef.current === "BANK TRANSFER" && !bankValueRef.current) {
      return fail("Select bank name", bankRef.current);
    }
    const mop = mopValueRef.current === "BANK TRANSFER" ? `BANK TRANSFER / ${bankValueRef.current}` : "CASH";
    try {
      const amt = formatAdvance();
      const row = await api.post<any>("/api/bookings", {
        guestName: form.guestName.trim(),
        cardNo: form.cardNo,
        advance: Math.round(Number(amt) * 100),
        mop,
      });
      setMsg(`Saved reservation ${row.reservation_no}`);
      setNo((row.reservation_no || no) + 1);
      resetPay();
      setForm(blank);
      setTimeout(() => guestRef.current?.focus(), 0);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Save failed");
    }
  }

  function clear() {
    setMsg("");
    setOk(false);
    resetPay();
    setForm(blank);
    setTimeout(() => guestRef.current?.focus(), 0);
  }

  function isDraft() {
    return form.guestName.trim() !== ""
      || form.cardNo.trim() !== ""
      || (Number(form.advance) > 0 && form.advance !== "0.00")
      || form.mop !== "CASH";
  }

  function requestExit() {
    if (isDraft()) setAskExit(true);
    else onExit();
  }

  useEffect(() => {
    function keys(e: globalThis.KeyboardEvent) {
      if (askExit || document.querySelector(".alert-dlg")) return;
      const active = document.activeElement;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (active === mopRef.current) {
          e.preventDefault();
          e.stopImmediatePropagation();
          stepMop(dir);
        } else if (active === bankRef.current) {
          e.preventDefault();
          e.stopImmediatePropagation();
          stepBank(dir);
        }
        return;
      }
      if (e.key === "Enter" && (active === mopRef.current || active === bankRef.current)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setMsg("");
        if (active === mopRef.current) afterMop();
        else saveRef.current?.focus();
        return;
      }
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      requestExit();
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });
  return (
    <div className="adv-page">
      <aside className="adv-side" />
      <div className="adv-form">
        <div className="adv-top">
          <span>Reservation No : &nbsp; {no}</span>
          <span>Date : {dmy()} {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <label>Guest Name <input ref={guestRef} className="win green" tabIndex={1} autoFocus value={form.guestName} onChange={(e) => setForm({ ...form, guestName: e.target.value })} onKeyDown={onEnter(checkGuest, () => cardRef.current?.focus())} /></label>
        <label>Card No <input ref={cardRef} className="win green" data-num="card" tabIndex={2} inputMode="numeric" maxLength={4} value={form.cardNo} onChange={(e) => setForm({ ...form, cardNo: cardNoDigits(e.target.value) })} onBlur={() => { if (form.cardNo && !cardNoReady(form.cardNo)) stayOnCard(cardRef.current); }} onKeyDown={onEnter(checkCard, () => advanceRef.current?.focus())} /></label>
        <label>Advance <input ref={advanceRef} className="win" data-num="dec" tabIndex={3} inputMode="decimal" value={form.advance} onChange={(e) => setAdvance(e.target.value)} onFocus={(e) => e.target.select()} onBlur={() => setForm((f) => ({ ...f, advance: formatAdvance(f.advance) }))} onKeyDown={onEnter(() => { const okAmt = checkAdvance(); if (okAmt) setForm((f) => ({ ...f, advance: formatAdvance(f.advance) })); return okAmt; }, () => mopRef.current?.focus())} /></label>
        <label>MOP <span className="st-drop"><input ref={mopRef} className="win" readOnly tabIndex={4} data-cycle="1" value={form.mop} /><span className="st-drop-btn" aria-hidden="true" /></span></label>
        {form.mop === "BANK TRANSFER" && (
          <label>Bank Name <span className="st-drop"><input ref={bankRef} className="win" readOnly tabIndex={5} data-cycle="1" value={bankName} /><span className="st-drop-btn" aria-hidden="true" /></span></label>
        )}
        <button ref={saveRef} className="fn adv-save" tabIndex={6} onClick={() => void save()} onKeyDown={onEnter(() => true, () => void save())}>Save</button>
        {msg && <p className={ok ? "ok" : "flash"}>{msg}</p>}
      </div>
      <div className="adv-foot">
        <button className="fn" onClick={clear}>Clear/New</button>
        <button className="fn" onClick={requestExit}>Exit</button>
      </div>
      {askExit && (
        <ConfirmAsk
          onYes={() => { setAskExit(false); onExit(); }}
          onNo={() => setAskExit(false)}
        />
      )}
    </div>
  );
}

function billDateLabel(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${pad(d.getDate())}/${MONTHS[d.getMonth()]}/${d.getFullYear()}`;
}

/** Bill Report shows only the running no (10023), not session prefix 26-27/. */
function shortBillNo(raw?: string | number | null) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const slash = s.lastIndexOf("/");
  const tail = slash >= 0 ? s.slice(slash + 1) : s;
  return tail.replace(/\D/g, "") || tail;
}

function BillReport({ outlet, onExit }: { outlet?: string; onExit: () => void }) {
  const request = useReportRequest();
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [outletName, setOutletName] = useState(outlet || "BAR");
  const [bill, setBill] = useState("");
  const [tableNo, setTableNo] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "cancelled">("all");
  const [discounted, setDiscounted] = useState(false);
  const [complimentaryOnly, setComplimentaryOnly] = useState(false);
  const [complimentaryAccountId, setComplimentaryAccountId] = useState("");
  const [complimentaryAccounts, setComplimentaryAccounts] = useState<CompAccount[]>([]);
  const [complimentaryAccountsError, setComplimentaryAccountsError] = useState(false);
  const [data, setData] = useState<any>({ rows: [], total: 0 });
  const [sel, setSel] = useState<string | null>(null);
  const [billEdit, setBillEdit] = useState<{
    invoiceId: string;
    orderId: string;
    table: { id: string; code: string; name: string; status: string; floor_name: string; floor_id: string; current_session_id: string | null; card_number?: string; outlet?: string };
    outlet: string;
    guest: string;
    mobile: string;
  } | null>(null);
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string; sku: string; base_price?: number }>>([]);
  const [miss, setMiss] = useState("");
  const [settle, setSettle] = useState<{
    invoiceId: string;
    table: { id: string; code: string; status: string; card_number?: string; outlet?: string };
    outlet: string;
  } | null>(null);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  useEffect(() => {
    setOutletName(outlet || "BAR");
  }, [outlet]);

  useEffect(() => {
    if (!billEdit || catalog.length) return;
    const controller = new AbortController();
    api.get<typeof catalog>("/api/products", controller.signal).then(setCatalog).catch(() => null);
    return () => controller.abort();
  }, [billEdit, catalog.length]);

  useEffect(() => {
    api.get<CompAccount[]>("/api/complimentary")
      .then(setComplimentaryAccounts)
      .catch(() => setComplimentaryAccountsError(true));
  }, []);

  async function load(nextOutlet = outletName) {
    const q = new URLSearchParams({
      from,
      to,
      outlet: nextOutlet,
      bill: shortBillNo(bill) || bill.trim(),
      table: tableNo,
      status,
      discounted: discounted ? "1" : "0",
      complimentary: complimentaryOnly ? "1" : "0",
      complimentaryAccountId,
    });
    await request.load<any>(`/api/reports/bills?${q}`, (next) => {
      setData(next);
      const rows = next.rows || [];
      setSel(rows.length ? String(rows[rows.length - 1].invoice_id || rows[rows.length - 1].invoice_number) : null);
    });
  }

  function onFilterEnter(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    void load();
  }

  useEffect(() => {
    load(outlet || "BAR").catch(() => null);
  }, [outlet]);

  function openRestaurantBill(row: any) {
    const orderId = String(row?.order_id || "").trim();
    const tableId = String(row?.table_id || "").trim();
    if (!orderId || !tableId) {
      setMiss("Could not open this bill");
      return;
    }
    const code = String(row.table_code || "");
    setBillEdit({
      invoiceId: String(row.invoice_id || ""),
      orderId,
      table: {
        id: tableId,
        code: code || String(row.table_no || ""),
        name: String(row.table_label || row.table_no || code),
        status: "PAYMENT_PENDING",
        floor_name: "",
        floor_id: "",
        current_session_id: null,
        card_number: String(row.order_card || ""),
        outlet: String(row.outlet_name || outletName || "BAR"),
      },
      outlet: String(row.outlet_name || outletName || "BAR"),
      guest: String(row.guest || ""),
      mobile: String(row.mobile || ""),
    });
  }

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (billEdit || settle || document.querySelector(".bill-dlg, .settle-dlg, .su-dlg, .alert-dlg, .confirm-dlg")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onExit();
        return;
      }
      const typing = (e.target as HTMLElement | null)?.closest("input, select, textarea");
      if (typing && e.key === "Enter") {
        // Filter fields: Enter runs Show (handled on the control)
        return;
      }
      const rows = data.rows || [];
      if (!rows.length) return;
      const idx = Math.max(0, rows.findIndex((r: any) => String(r.invoice_id || r.invoice_number) === selRef.current));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (typing) return;
        e.preventDefault();
        e.stopPropagation();
        const next = e.key === "ArrowDown"
          ? rows[Math.min(rows.length - 1, idx + 1)]
          : rows[Math.max(0, idx - 1)];
        setSel(String(next.invoice_id || next.invoice_number));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const row = rows[idx];
        if (row) openRestaurantBill(row);
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  const rows = data.rows || [];
  const total = Number(data.total) || rows.reduce((s: number, r: any) => s + (Number(r.net_amount) || 0), 0);

  return (
    <div className="set-page bill-rpt-page">
      <ReportLoadStatus loading={request.loading} error={request.error} />
      <div className="set-filter bill-rpt-filter">
        <div className="set-fields">
          <div className="set-row">
            <label>Outlet Name : <select className="win" value={outletName} onChange={(e) => setOutletName(e.target.value)} onKeyDown={onFilterEnter}>
              {OUTLETS.map((o) => <option key={o}>{o}</option>)}
            </select></label>
            <label>Bill No. : <input className="win" value={bill} onChange={(e) => setBill(e.target.value)} onKeyDown={onFilterEnter} /></label>
            <label>Table/Room No. : <input className="win" value={tableNo} onChange={(e) => setTableNo(e.target.value)} onKeyDown={onFilterEnter} /></label>
          </div>
          <div className="set-row">
            <label>Date From : <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} onKeyDown={onFilterEnter} /></label>
            <label>To Date : <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={onFilterEnter} /></label>
            <label className="set-check"><input type="radio" name="bill-status" checked={status === "all"} onChange={() => setStatus("all")} /> Show All</label>
            <label className="set-check"><input type="radio" name="bill-status" checked={status === "cancelled"} onChange={() => setStatus("cancelled")} /> Cancelled Only</label>
            <label className="set-check"><input type="radio" name="bill-status" checked={status === "active"} onChange={() => setStatus("active")} /> Active Only</label>
            <label className="set-check"><input type="checkbox" checked={discounted} onChange={(e) => setDiscounted(e.target.checked)} /> Discounted Bill Only</label>
          </div>
          <div className="set-row">
            <label className="set-check"><input type="checkbox" checked={complimentaryOnly} onChange={(e) => setComplimentaryOnly(e.target.checked)} onKeyDown={onFilterEnter} /> Complimentary Only</label>
            <label>Complimentary A/C <select className="win" value={complimentaryAccountId} onChange={(e) => setComplimentaryAccountId(e.target.value)} disabled={complimentaryAccountsError}>
              <option value="">{complimentaryAccountsError ? "Could not load accounts" : "All accounts"}</option>
              {complimentaryAccounts.map((account) => (
                <option key={account.id} value={account.id}>{String(account.code).padStart(3, "0")} - {account.name}</option>
              ))}
            </select></label>
          </div>
        </div>
        <div className="set-btns">
          <button type="button" className="fn" onClick={() => void load()}>Show</button>
          <button type="button" className="fn" disabled tabIndex={-1}>Mail</button>
          <button type="button" className="fn" onClick={() => {
            const row = rows.find((r: any) => String(r.invoice_id || r.invoice_number) === sel);
            if (row) openRestaurantBill(row);
          }}>Details</button>
          <button type="button" className="fn" onKeyDown={ignoreRepeatedPrintKey} onClick={printPage}>Print</button>
          <button type="button" className="fn" disabled tabIndex={-1}>Export</button>
          <button type="button" className="fn" onClick={onExit}>Exit</button>
        </div>
      </div>
      <div className="set-grid-wrap">
        <table className="data set-table bill-rpt-table">
          <thead>
            <tr>
              {["Bill Date", "BillNo", "TableNo", "Net Amount", "Service Charge", "Complimentary A/C", "Remark", "UserName", "CASH", "card", "B.T.C.", "WALLET", "ROOM TRANSFER", "Other MOD", "ALLOWAN"].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => {
              const key = String(r.invoice_id || r.invoice_number);
              const on = key === sel;
              const tableLabel = `T : ${r.table_label || r.table_code || r.table_no || ""}`;
              return (
                <tr
                  key={key}
                  className={on ? "on" : ""}
                  tabIndex={0}
                  onClick={() => setSel(key)}
                  onDoubleClick={() => openRestaurantBill(r)}
                >
                  <td>{billDateLabel(r.created_at)}</td>
                  <td>{shortBillNo(r.invoice_number)}</td>
                  <td>{tableLabel}</td>
                  <td className="num">{inr(r.net_amount)}</td>
                  <td className="num">{Number(r.service_charge) ? inr(r.service_charge) : ""}</td>
                  <td>{r.complimentary_account || (r.is_complimentary ? "Complimentary" : "")}</td>
                  <td>{r.remark || ""}</td>
                  <td>{r.username || ""}</td>
                  <td className="num">{Number(r.cash) ? inr(r.cash) : ""}</td>
                  <td className="num">{Number(r.card) ? inr(r.card) : ""}</td>
                  <td className="num">{Number(r.btc) ? inr(r.btc) : ""}</td>
                  <td className="num">{Number(r.wallet) ? inr(r.wallet) : ""}</td>
                  <td className="num">{Number(r.room_transfer) ? inr(r.room_transfer) : ""}</td>
                  <td className="num">{Number(r.other_mod) ? inr(r.other_mod) : ""}</td>
                  <td className="num">{Number(r.allowance) ? inr(r.allowance) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="bill-rpt-foot">
        <span className="hint">Mouse double click to alter bill</span>
        <label>Total Amount : <input className="win" readOnly value={inr(total)} /></label>
        <span className="hint right">Mail button enable after print</span>
      </div>
      {miss && <AlertBox message={miss} onClose={() => setMiss("")} />}
      {billEdit && (
        <PrepareBillDialog
          orderId={billEdit.orderId}
          existingInvoiceId={billEdit.invoiceId}
          table={billEdit.table}
          outlet={billEdit.outlet}
          waiter=""
          guest={billEdit.guest}
          mobile={billEdit.mobile}
          catalog={catalog}
          onClose={() => setBillEdit(null)}
          onChanged={() => { void load(); }}
          onPrinted={() => {
            setBillEdit(null);
            void load();
          }}
          onSettle={(inv) => {
            if (!billEdit) return;
            const outletName = billEdit.outlet;
            const invoiceId = String(inv.id);
            setBillEdit(null);
            if (outletName === "THE BOSS CLUB") {
              void api.post(`/api/invoices/${invoiceId}/settle-club`, {}).then(() => load()).catch((e) => {
                setMiss(e instanceof Error ? e.message : "Could not settle");
              });
              return;
            }
            setSettle({ invoiceId, table: billEdit.table, outlet: outletName });
            void load();
          }}
          onMessage={setMiss}
        />
      )}
      {settle && (
        <SettleDialog
          invoiceId={settle.invoiceId}
          table={settle.table}
          outlet={settle.outlet}
          cardNo=""
          onClose={() => { setSettle(null); void load(); }}
          onDone={() => { setSettle(null); void load(); }}
          onMessage={setMiss}
        />
      )}
    </div>
  );
}

function KotAddTableDialog({
  kotKey,
  onClose,
}: {
  kotKey: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [sel, setSel] = useState(0);
  const [err, setErr] = useState("");
  const dataRef = useRef<any>(null);
  const printRef = useRef<HTMLButtonElement>(null);
  const reprintRef = useRef<() => void>(() => {});
  const close = useRef(onClose);
  close.current = onClose;
  dataRef.current = data;

  useEffect(() => {
    let gone = false;
    setData(null);
    setErr("");
    api.get<any>(`/api/reports/kots/${encodeURIComponent(kotKey)}`).then((next) => {
      if (gone) return;
      setData(next);
      setSel(0);
      setErr("");
      setTimeout(() => printRef.current?.focus(), 0);
    }).catch((e) => { if (!gone) setErr(e instanceof Error ? e.message : "KOT not found"); });
    return () => { gone = true; };
  }, [kotKey]);

  async function reprint() {
    const id = dataRef.current?.id;
    if (!id) { setErr("KOT still loading"); return; }
    printRef.current?.focus();
    try {
      await reprintKot(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Print failed");
    }
  }
  reprintRef.current = () => void reprint();

  useEffect(() => {
    function keys(e: globalThis.KeyboardEvent) {
      if (document.querySelector(".confirm-dlg, .alert-dlg")) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key === "F6") { e.preventDefault(); e.stopPropagation(); if (!e.repeat) reprintRef.current(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        printRef.current?.focus();
        if (!e.repeat) reprintRef.current();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const n = dataRef.current?.items?.length || 0;
        if (!n) return;
        e.preventDefault();
        e.stopPropagation();
        setSel((i) => e.key === "ArrowDown" ? Math.min(n - 1, i + 1) : Math.max(0, i - 1));
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, []);

  const items: Array<{ id: string; name: string; qty: number; remark: string; rate: number; code: string }> = data?.items || [];
  const tableItems: Array<{ code: string; name: string; qty: number }> = data?.table_items || [];
  const qtyTxt = (n: number) => Number(n || 0).toFixed(2);
  const remark = String(data?.notes || "");

  return createPortal(
    <div className="kot-add-dlg kot-view">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Add Table
        <CapBtns onClose={onClose} />
      </div>
      <div className="kot-add-body">
        <div className="kot-add-main">
          <div className="kot-add-hdr">
            <label className="pair"><span className="lbl">Date</span><input className="win" readOnly tabIndex={-1} value={data?.date_label || ""} /></label>
            <label className="pair"><span className="lbl">KOT</span><span className="kot-text">{data?.kot_number || kotKey}</span></label>
            <label className="pair"><span>Table No</span>
              <select className="win green" disabled tabIndex={-1} value={data?.table_no || ""}>
                {data?.table_no ? <option value={data.table_no}>{data.table_no}</option> : <option value=""> </option>}
              </select>
            </label>
            <label className="pair"><span>Waiter</span><input className="win green" readOnly tabIndex={-1} value={data?.waiter || ""} style={{ width: 48 }} /></label>
            <label className="pair"><span>Manual Kot</span><input className="win" readOnly tabIndex={-1} value="" style={{ width: 72 }} /></label>
            <button type="button" className="fn kot-comp" disabled tabIndex={-1}>Complementary KOT</button>
          </div>

          <div className="kot-add-grid">
            <div className="kot-add-head">
              <div>Sr.No.</div><div>ItemName</div><div>Rate</div><div>Qty</div><div>Remark</div>
            </div>
            <div className="kot-add-rows">
              {items.map((it, i) => (
                <div
                  key={it.id}
                  className={`kot-add-row ${i === sel ? "on" : ""}`}
                  onClick={() => setSel(i)}
                >
                  <div>{i + 1}</div>
                  <div className="name">{it.name}</div>
                  <div className="num">{rupees(it.rate)}</div>
                  <div className="num">{qtyTxt(it.qty)}</div>
                  <div className="remark-cell">{it.remark || ""}</div>
                </div>
              ))}
              {!items.length && (
                <div className="kot-add-row empty">
                  <div /><div>{data ? "No items" : "Loading…"}</div>
                </div>
              )}
            </div>
          </div>

          <div className="fn-box">
            <div className="remark">Remark : <input className="win" readOnly tabIndex={-1} value={remark} /></div>
            <table className="fn-table">
              <tbody>
                <tr>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>Prepare Bill (F10)</button></td>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>Settlement (F11)</button></td>
                  <td><button
                    ref={printRef}
                    type="button"
                    className="fn"
                    onClick={() => void reprint()}
                  >Print KOT (F6)</button></td>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>Update (F5)</button></td>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>Delete (F4)</button></td>
                </tr>
                <tr>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>KOT Rep. (F7)</button></td>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>Bill Rep. (F8)</button></td>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>S. Report (F12)</button></td>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>Item transfer</button></td>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>T. Transfer (F9)</button></td>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>Create Item (F3)</button></td>
                </tr>
                <tr>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>Load Hold</button></td>
                  <td><button type="button" className="fn" disabled tabIndex={-1}>Hold KOT</button></td>
                  <td /><td /><td />
                  <td><button type="button" className="fn" onClick={onClose}>Exit</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <aside className="estimate item-list kot-add-side">
          <div className="estimate-head">Table No. Items List</div>
          <table>
            <colgroup><col className="c-code" /><col /><col className="c-qty" /></colgroup>
            <thead>
              <tr><th>Code</th><th>ItemName</th><th>Qty</th></tr>
            </thead>
            <tbody>
              {tableItems.map((row, i) => (
                <tr key={`${row.code}-${row.name}-${i}`}>
                  <td>{row.code}</td>
                  <td>{row.name}</td>
                  <td className="qty">{row.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="estimate-fill" />
          <div className="estimate-total">Total Amount: {rupees(data?.total_amount)}</div>
        </aside>
      </div>
      {err && <AlertBox message={err} onClose={() => setErr("")} />}
    </div>,
    document.body,
  );
}

function KotReport({ outlet, onExit }: { outlet?: string; onExit: () => void }) {
  const request = useReportRequest();
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [outletName, setOutletName] = useState(outlet || "BAR");
  const [kotNo, setKotNo] = useState("");
  const [tableNo, setTableNo] = useState("");
  const [billNo, setBillNo] = useState("");
  const [complementary, setComplementary] = useState("Select");
  const [data, setData] = useState<any>({ rows: [] });
  const [sel, setSel] = useState<string | null>(null);
  const [kotKey, setKotKey] = useState<string | null>(null);
  const [miss, setMiss] = useState("");
  const selRef = useRef<string | null>(null);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  selRef.current = sel;

  function focusSelRow(scrollLast = false) {
    const wrap = gridWrapRef.current;
    if (!wrap) return;
    if (scrollLast) wrap.scrollTop = wrap.scrollHeight;
    const tr = wrap.querySelector("tbody tr.on") as HTMLElement | null;
    tr?.focus({ preventScroll: true });
    if (!scrollLast) tr?.scrollIntoView({ block: "nearest" });
  }

  useEffect(() => {
    setOutletName(outlet || "BAR");
  }, [outlet]);

  async function load(nextOutlet = outletName) {
    const q = new URLSearchParams({
      from,
      to,
      outlet: nextOutlet,
      kot: kotNo.trim(),
      table: tableNo.trim(),
      bill: billNo.trim(),
      complementary,
    });
    await request.load<any>(`/api/reports/kots?${q}`, (next) => {
      setData(next);
      const rows = next.rows || [];
      setSel(rows.length ? String(rows[rows.length - 1].id || rows[rows.length - 1].kot_number) : null);
    });
  }

  function onFilterEnter(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    void load();
  }

  useEffect(() => {
    load(outlet || "BAR").catch(() => null);
  }, [outlet]);

  useLayoutEffect(() => {
    const rows = data.rows || [];
    if (!rows.length || !sel) return;
    const lastKey = String(rows[rows.length - 1].id || rows[rows.length - 1].kot_number);
    // After open / Show: land on last row so Up/Down work without a click
    if (sel === lastKey) focusSelRow(true);
  }, [data, sel]);

  function openRow(row: any) {
    const key = String(row?.id || row?.kot_number || "").trim();
    if (key) setKotKey(key);
  }

  async function reprintSelected() {
    const rows = data.rows || [];
    const row = rows.find((r: any) => String(r.id || r.kot_number) === selRef.current);
    const id = String(row?.id || "").trim();
    if (!id) {
      setMiss("Select a KOT first");
      return;
    }
    try {
      await reprintKot(id);
    } catch (e) {
      setMiss(e instanceof Error ? e.message : "Reprint failed");
    }
  }

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (kotKey || document.querySelector(".kot-view, .bill-dlg, .su-dlg, .alert-dlg, .confirm-dlg, .confirm-overlay")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onExit();
        return;
      }
      if (e.key === "F1") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) void reprintSelected();
        return;
      }
      const typing = (e.target as HTMLElement | null)?.closest("input, select, textarea");
      if (typing && e.key === "Enter") return;
      const rows = data.rows || [];
      if (!rows.length) return;
      const idx = Math.max(0, rows.findIndex((r: any) => String(r.id || r.kot_number) === selRef.current));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (typing) return;
        e.preventDefault();
        e.stopPropagation();
        const next = e.key === "ArrowDown"
          ? rows[Math.min(rows.length - 1, idx + 1)]
          : rows[Math.max(0, idx - 1)];
        setSel(String(next.id || next.kot_number));
        requestAnimationFrame(() => focusSelRow(false));
        return;
      }
      if (e.key === "Enter") {
        if (typing) return;
        e.preventDefault();
        e.stopPropagation();
        const row = rows[idx];
        if (row) openRow(row);
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  const rows = data.rows || [];
  const titleOutlet = outletName || outlet || "BAR";

  return (
    <div className="set-page kot-rpt-page">
      <ReportLoadStatus loading={request.loading} error={request.error} />
      <div className="set-filter bill-rpt-filter">
        <div className="set-fields">
          <div className="set-title">Select Filter &nbsp;— Restaurant KOT Report - {titleOutlet}</div>
          <div className="set-row">
            <label>Date From : <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} onKeyDown={onFilterEnter} /></label>
            <label>To Date : <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={onFilterEnter} /></label>
            <label>Complementary : <select className="win" value={complementary} onChange={(e) => setComplementary(e.target.value)} onKeyDown={onFilterEnter}>
              <option>Select</option><option>Yes</option><option>No</option>
            </select></label>
          </div>
          <div className="set-row">
            <label>KOT No : <input className="win" value={kotNo} onChange={(e) => setKotNo(e.target.value)} onKeyDown={onFilterEnter} /></label>
            <label>Table No. : <input className="win" value={tableNo} onChange={(e) => setTableNo(e.target.value)} onKeyDown={onFilterEnter} /></label>
            <label>Bill No : <input className="win" value={billNo} onChange={(e) => setBillNo(e.target.value)} onKeyDown={onFilterEnter} /></label>
            <label>Outlet : <select className="win" value={outletName} onChange={(e) => setOutletName(e.target.value)} onKeyDown={onFilterEnter}>
              {OUTLETS.map((o) => <option key={o}>{o}</option>)}
            </select></label>
          </div>
        </div>
        <div className="set-btns">
          <button type="button" className="fn" onClick={() => void load()}>Show</button>
          <button type="button" className="fn" disabled tabIndex={-1}>Excel</button>
          <button type="button" className="fn" onKeyDown={ignoreRepeatedPrintKey} onClick={printPage}>Print</button>
          <button type="button" className="fn" onClick={onExit}>Exit</button>
        </div>
      </div>
      <div className="set-grid-wrap" ref={gridWrapRef}>
        <table className="data set-table bill-rpt-table">
          <thead>
            <tr>
              {["KOT No", "Manual KOTNo", "Table No", "KOT Date", "Kot Time", "BillNo", "NetAmount", "StwardName", "KOTRemark", "UserID"].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => {
              const key = String(r.id || r.kot_number);
              const on = key === sel;
              return (
                <tr
                  key={key}
                  className={on ? "on" : ""}
                  tabIndex={on ? 0 : -1}
                  onClick={() => {
                    setSel(key);
                    requestAnimationFrame(() => focusSelRow(false));
                  }}
                  onDoubleClick={() => openRow(r)}
                >
                  <td>{r.kot_number}</td>
                  <td>{r.manual_kot || ""}</td>
                  <td>{r.table_label || r.table_code || r.table_no || ""}</td>
                  <td>{r.kot_date}</td>
                  <td>{r.kot_time}</td>
                  <td>{r.bill_no || "0"}</td>
                  <td className="num">{inr(r.net_amount)}</td>
                  <td>{r.steward || ""}</td>
                  <td>{r.kot_remark || ""}</td>
                  <td>{r.user_id || ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="bill-rpt-foot">
        <span className="hint">F1 : KOT Reprint</span>
      </div>
      {miss && <AlertBox message={miss} onClose={() => setMiss("")} />}
      {kotKey && (
        <KotAddTableDialog
          kotKey={kotKey}
          onClose={() => setKotKey(null)}
        />
      )}
    </div>
  );
}

type CardSettleRow = {
  booking_id: string;
  card_no: string;
  guest_name: string;
  booking_date: string;
  payment_mode: string;
  amount_paid: number;
  card_balance: number;
  remaining_balance: number;
};
type CardBillRow = {
  invoice_id: string;
  invoice_number: string;
  table_no: string;
  outlet: string;
  amount: number;
};

function CardBillDialog({
  bookingId,
  cardNo,
  guest,
  onClose,
}: {
  bookingId: string;
  cardNo: string;
  guest: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<CardBillRow[]>([]);
  const [sel, setSel] = useState(0);
  const [warn, setWarn] = useState("");
  const [busy, setBusy] = useState("");
  const [ready, setReady] = useState(false);
  const rowsRef = useRef<CardBillRow[]>([]);
  const selRef = useRef(0);
  const busyRef = useRef("");
  rowsRef.current = rows;
  selRef.current = sel;

  useEffect(() => {
    let live = true;
    api.get<{ rows: CardBillRow[] }>(`/api/reports/card-settlement/${encodeURIComponent(bookingId)}/bills`)
      .then((data) => {
        if (!live) return;
        setRows(data.rows || []);
        setReady(true);
      })
      .catch((e) => {
        if (!live) return;
        setWarn(e instanceof Error ? e.message : "Could not load bills");
        setReady(true);
      });
    return () => { live = false; };
  }, [bookingId]);

  async function printInvoice(invoiceId: string) {
    if (!invoiceId || busyRef.current) return;
    busyRef.current = invoiceId;
    setBusy(invoiceId);
    try {
      const out = await printBill(invoiceId);
      if (!out.ok) setWarn(out.error || "Print failed");
    } catch (e) {
      setWarn(e instanceof Error ? e.message : "Print failed");
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  }

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (warn || document.querySelector(".alert-dlg")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const list = rowsRef.current;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!list.length) return;
        e.preventDefault();
        e.stopPropagation();
        const next = e.key === "ArrowDown"
          ? Math.min(list.length - 1, selRef.current + 1)
          : Math.max(0, selRef.current - 1);
        selRef.current = next;
        setSel(next);
        const btn = document.querySelectorAll<HTMLButtonElement>(".cs-dlg [data-invoice-id]")[next];
        btn?.focus();
        return;
      }
      if (e.key === "Enter") {
        const el = e.target instanceof Element ? e.target : null;
        if (el?.closest("[data-cs-exit]")) return;
        const fromBtn = el?.closest("[data-invoice-id]")?.getAttribute("data-invoice-id") || "";
        const invoiceId = fromBtn || list[selRef.current]?.invoice_id;
        if (!invoiceId) return;
        e.preventDefault();
        e.stopPropagation();
        const idx = list.findIndex((r) => r.invoice_id === invoiceId);
        if (idx >= 0) {
          selRef.current = idx;
          setSel(idx);
        }
        if (!e.repeat) void printInvoice(invoiceId);
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  return (
    <div className="cs-dlg" role="dialog" aria-label="Card bills">
      <div className="dialog-cap">
        <span className="cap-dot" />
        <span>Card {cardNo}{guest ? ` — ${guest}` : ""}</span>
        <button type="button" className="cap-x" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="cs-body">
        <div className="cs-grid-wrap">
          <table className="cs-grid">
            <thead>
              <tr>
                <th>Invoice No</th>
                <th>Table No</th>
                <th>Outlet</th>
                <th>Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!ready && (
                <tr><td colSpan={5}>Loading…</td></tr>
              )}
              {ready && rows.length === 0 && (
                <tr><td colSpan={5}>No bill for this card</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={r.invoice_id} className={i === sel ? "on" : ""} onClick={() => setSel(i)}>
                  <td>{r.invoice_number}</td>
                  <td>{r.table_no}</td>
                  <td>{r.outlet}</td>
                  <td className="num">{inr(r.amount)}</td>
                  <td>
                    <button
                      type="button"
                      className="fn"
                      data-invoice-id={r.invoice_id}
                      disabled={busy === r.invoice_id}
                      onClick={(e) => {
                        e.stopPropagation();
                        selRef.current = i;
                        setSel(i);
                        void printInvoice(r.invoice_id);
                      }}
                    >
                      Print
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="cs-foot">
          <button type="button" className="fn" data-cs-exit="1" onClick={onClose}>Exit</button>
        </div>
      </div>
      {warn && <AlertBox message={warn} onClose={() => setWarn("")} />}
    </div>
  );
}

export function CardSettlementReport({ onExit, title = "Card Settlement Report" }: { onExit: () => void; title?: string }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [card, setCard] = useState("");
  const [rows, setRows] = useState<CardSettleRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [warn, setWarn] = useState("");
  const fromRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<string | null>(null);
  const rowsRef = useRef<CardSettleRow[]>([]);
  const loadGen = useRef(0);
  selRef.current = sel;
  rowsRef.current = rows;

  async function load() {
    const gen = ++loadGen.current;
    const q = new URLSearchParams({ from, to, card: card.trim() });
    try {
      const data = await api.get<{ rows: CardSettleRow[] }>(`/api/reports/card-settlement?${q}`);
      if (gen !== loadGen.current) return;
      const next = data.rows || [];
      setRows(next);
      setSel(next.length ? next[next.length - 1].booking_id : null);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setWarn(e instanceof Error ? e.message : "Could not load report");
    }
  }

  useEffect(() => { fromRef.current?.focus(); void load(); }, []);
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (openId || warn || document.querySelector(".cs-dlg, .alert-dlg")) return;
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA";
      if (typing) {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if (target === cardRef.current && card && !cardNoReady(card)) {
            stayOnCard(cardRef.current);
            return;
          }
          void load();
        }
        return;
      }
      const list = rowsRef.current;
      if (!list.length) return;
      const idx = Math.max(0, list.findIndex((r) => r.booking_id === selRef.current));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const next = list[e.key === "ArrowDown" ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1)];
        setSel(next.booking_id);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const id = selRef.current;
        if (id) setOpenId(id);
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  const open = rows.find((r) => r.booking_id === openId) || null;

  return (
    <div className="set-page">
      <div className="set-filter">
        <div className="set-fields">
          <div className="set-title">{title}</div>
          <div className="set-row">
            <label>Date From : <input ref={fromRef} className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To Date : <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <label>Card No : <input ref={cardRef} className="win" data-num="card" inputMode="numeric" maxLength={4} value={card} onChange={(e) => setCard(cardNoDigits(e.target.value))} onBlur={() => { if (card && !cardNoReady(card)) stayOnCard(cardRef.current); }} /></label>
          </div>
        </div>
        <div className="set-btns">
          <button className="fn" onClick={() => { if (card && !cardNoReady(card)) { stayOnCard(cardRef.current); return; } void load(); }}>Show</button>
          <button className="fn" onClick={onExit}>Exit</button>
        </div>
      </div>
      <div className="set-grid-wrap">
        <table className="data set-table">
          <thead>
            <tr>
              <th>Card No</th>
              <th>Guest Name</th>
              <th>Booking Date</th>
              <th>Payment Mode</th>
              <th>Amount Paid</th>
              <th>Card Balance</th>
              <th>Remaining Balance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.booking_id}
                className={r.booking_id === sel ? "on" : ""}
                tabIndex={r.booking_id === sel ? 0 : -1}
                onClick={() => setSel(r.booking_id)}
                onDoubleClick={() => setOpenId(r.booking_id)}
              >
                <td>{r.card_no}</td>
                <td>{r.guest_name}</td>
                <td>{stampGrid(r.booking_date)}</td>
                <td>{r.payment_mode || "—"}</td>
                <td className="num">{inr(r.amount_paid)}</td>
                <td className="num">{inr(r.card_balance)}</td>
                <td className="num">{inr(r.remaining_balance)}</td>
                <td>
                  <button type="button" className="fn" onClick={() => setOpenId(r.booking_id)}>Show</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <CardBillDialog
          bookingId={open.booking_id}
          cardNo={open.card_no}
          guest={open.guest_name}
          onClose={() => setOpenId(null)}
        />
      )}
      {warn && <AlertBox message={warn} onClose={() => setWarn("")} />}
    </div>
  );
}

type TransferRow = {
  id: string;
  created_at: string;
  from_table: string | null;
  to_table: string | null;
  item_names?: string;
  item_count?: number;
  staff_name: string;
  reason: string | null;
};

function TransferReport({ kind, onExit }: { kind: "item" | "table"; onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const title = kind === "item" ? "Item Transfer Report" : "Table Transfer Report";
  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<TransferRow[]>(`/api/reports/${kind}-transfers?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load transfer report");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  const columns: Array<[keyof TransferRow, string]> = kind === "item"
    ? [["created_at", "Date / Time"], ["from_table", "From Table"], ["to_table", "To Table"], ["item_names", "Transferred Items"], ["item_count", "Qty"], ["staff_name", "Staff"], ["reason", "Reason"]]
    : [["created_at", "Date / Time"], ["from_table", "From Table"], ["to_table", "To Table"], ["staff_name", "Staff"], ["reason", "Reason"]];
  return (
    <section className="rpt-page transfer-report" aria-labelledby="transfer-title">
      <header className="transfer-heading">
        <h1 id="transfer-title">{title}</h1>
        <button type="button" className="fn" onClick={onExit}>Exit</button>
      </header>
      <div className="rpt-bar transfer-filters">
        <FilterDates from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <button type="button" className="fn" disabled={loading} onClick={load}>Refresh</button>
      </div>
      <div className={`transfer-grid transfer-grid--${kind}`} tabIndex={0} role="region" aria-labelledby="transfer-title" aria-busy={loading}>
        <table aria-labelledby="transfer-title">
          <thead>
            <tr>{columns.map(([key, label]) => <th key={key} scope="col" className={`transfer-${key}`}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {!loading && !error && rows.map((row) => (
              <tr key={row.id}>
                {columns.map(([key]) => (
                  <td key={key} className={`transfer-${key}`}>
                    {key === "created_at" ? stampGrid(row.created_at) || "—" : String(row[key] ?? "") || "—"}
                  </td>
                ))}
              </tr>
            ))}
            {(loading || error || !rows.length) && (
              <tr>
                <td className="transfer-empty" colSpan={columns.length}>
                  <span role={error ? "alert" : "status"}>
                    {loading ? "Loading transfers…" : error || "No transfers found for this date range."}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type KotCancellationPage = {
  rows: Array<{
    id: string;
    created_at: string;
    kot_number: string;
    username: string | null;
    table_no: string | null;
    table_name: string | null;
    remark: string | null;
  }>;
  hasNext: boolean;
};

function KotCancellationReport({ onExit }: { onExit: () => void }) {
  const today = isoDay();
  const [filters, setFilters] = useState({ from: `${today}T00:00`, to: `${today}T23:59`, username: "", tableNo: "" });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<KotCancellationPage>({ rows: [], hasNext: false });
  const request = useReportRequest();

  function load(nextFilters: typeof filters, nextPage: number) {
    const from = new Date(nextFilters.from);
    const to = new Date(nextFilters.to);
    to.setSeconds(59, 999);
    const query = new URLSearchParams({
      ...nextFilters, from: from.toISOString(), to: to.toISOString(), page: String(nextPage),
    });
    void request.load<KotCancellationPage>(`/api/reports/kot-cancellations?${query}`, (result) => {
      setApplied(nextFilters);
      setPage(nextPage);
      setData(result);
    });
  }
  useEffect(() => { load(filters, 1); }, []);

  return (
    <section className="rpt-page transfer-report" aria-labelledby="kot-cancellation-title">
      <header className="transfer-heading">
        <h1 id="kot-cancellation-title">KOT Cancellation Report</h1>
        <button type="button" className="fn" onClick={onExit}>Exit</button>
      </header>
      <form className="rpt-bar transfer-filters kot-cancellation-controls" onSubmit={(event) => {
        event.preventDefault();
        load(filters, 1);
      }}>
        <label>From <input type="datetime-local" required value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
        <label>To <input type="datetime-local" required min={filters.from} value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
        <label>Username <input value={filters.username} onChange={(e) => setFilters({ ...filters, username: e.target.value })} /></label>
        <label>Table No. <input value={filters.tableNo} onChange={(e) => setFilters({ ...filters, tableNo: e.target.value })} /></label>
        <button className="fn" disabled={request.loading}>Show</button>
      </form>
      <ReportLoadStatus loading={request.loading} error={request.error} />
      <div className="transfer-grid transfer-grid--item" tabIndex={0} role="region" aria-labelledby="kot-cancellation-title" aria-busy={request.loading}>
        <table>
          <thead>
            <tr>
              <th className="transfer-created_at" scope="col">Cancelled At</th>
              <th scope="col">KOT No.</th><th scope="col">Username</th><th scope="col">Table No.</th>
              <th scope="col">Table Name</th><th scope="col">Remark</th>
            </tr>
          </thead>
          <tbody>
            {!request.loading && !request.error && data.rows.map((row) => (
              <tr key={row.id}>
                <td className="transfer-created_at">{stampGrid(row.created_at)}</td>
                <td>{row.kot_number}</td><td>{row.username || "—"}</td><td>{row.table_no || "—"}</td>
                <td>{row.table_name || "—"}</td><td>{row.remark || "—"}</td>
              </tr>
            ))}
            {!request.loading && !request.error && !data.rows.length && (
              <tr><td colSpan={6} className="transfer-empty">No KOT cancellations match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {(page > 1 || data.hasNext) && (
        <div className="rpt-bar transfer-filters kot-cancellation-controls">
          <button type="button" className="fn" disabled={request.loading || page === 1} onClick={() => load(applied, page - 1)}>Previous</button>
          <span aria-live="polite">Page {page}</span>
          <button type="button" className="fn" disabled={request.loading || !data.hasNext} onClick={() => load(applied, page + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}

export function ReportHost({ view, outlet, onExit }: { view: NavView; outlet?: string; onExit: () => void }) {
  const supported = [
    "item-wise-detail", "point-of-sales", "gst-report", "item-wise-sale", "item-wise-group",
    "settlement-report", "card-settlement-report", "booking-report", "card-block",
    "advance-booking", "kot-report", "kot-cancellation-report", "bill-report", "history", "reports", "time-sale", "tax-wise", "item-transfer-report", "table-transfer-report",
  ].includes(view);
  useEffect(() => {
    if (!supported) onExit();
  }, [supported, onExit]);

  if (view === "item-wise-detail") return <ItemWiseDetail onExit={onExit} />;
  if (view === "point-of-sales") return <PointOfSales onExit={onExit} />;
  if (view === "gst-report") return <GstReport onExit={onExit} />;
  if (view === "item-wise-sale") return <ItemWiseSale onExit={onExit} />;
  if (view === "item-wise-group") return <ItemWiseGroupSales onExit={onExit} />;
  if (view === "item-transfer-report") return <TransferReport key={view} kind="item" onExit={onExit} />;
  if (view === "table-transfer-report") return <TransferReport key={view} kind="table" onExit={onExit} />;
  if (view === "settlement-report") return <SettlementReport outlet={outlet} onExit={onExit} />;
  if (view === "card-settlement-report") return <CardSettlementReport onExit={onExit} />;
  if (view === "booking-report") return <CardSettlementReport onExit={onExit} title="Booking Report" />;
  if (view === "card-block") return <CardBlock onExit={onExit} />;
  if (view === "advance-booking") return <AdvanceBooking onExit={onExit} />;
  if (view === "kot-report") return <KotReport outlet={outlet} onExit={onExit} />;
  if (view === "kot-cancellation-report") return <KotCancellationReport onExit={onExit} />;
  if (view === "bill-report" || view === "history") return <BillReport outlet={outlet} onExit={onExit} />;
  if (view === "reports") return <GstReport onExit={onExit} />;
  if (view === "time-sale" || view === "tax-wise") {
    return (
      <GridReport
        title={view === "time-sale" ? "Time Sale Report" : "Tax Wise Report"}
        endpoint="/api/reports/item-wise"
        columns={[["item_name","Item"],["qty","Qty"],["amount","Amount"],["kot_at","Time"],["station","Outlet"]]}
        onExit={onExit}
      />
    );
  }
  // Keep the work area useful for the render before the fallback navigation runs.
  return <div className="rpt-page" role="status">Returning to the main screen…</div>;
}
