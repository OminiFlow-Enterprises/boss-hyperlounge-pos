import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { parseRupeesInput } from "../shared/money";
import type { NavView } from "../shared/types";
import { AlertBox, ConfirmAsk } from "./BillDialogs";

const OUTLETS = ["BAR", "CAFE", "NC", "RESTAURANT", "THE BOSS CLUB"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

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

function CrystalChrome({ children, onExit }: { children: ReactNode; onExit: () => void }) {
  return (
    <div className="cr-shell">
      <div className="cr-toolbar">
        <button className="fn" onClick={() => window.print()}>Print</button>
        <button className="fn">Export</button>
        <button className="fn">Show</button>
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

export function GstReport({ onExit }: { onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [data, setData] = useState<any>(null);
  async function load() {
    setData(await api.get(`/api/reports/gst?from=${from}&to=${to}`));
  }
  useEffect(() => { load().catch(() => null); }, []);
  const d = data || { total: 0, discount: 0, service: 0, tax: 0, mop: [] };
  const gtotal = d.total - d.discount;
  const rows = [
    ["Total", inr(d.total)],
    ["Discount", inr(d.discount)],
    ["G.Total", inr(gtotal)],
    ["Service Charge", inr(d.service)],
    ["Non GST", "0.00"],
    ["GST 5%", "0.00"],
    ["GST 18%", inr(d.tax)],
    ["Vat 20%", "0.00"],
    ["Surcharge 2.5%", "0.00"],
    ["Round Off", "0.00"],
    ["Total Tax", inr(d.tax)],
    ["Net Amount", inr(d.total)],
    ["Bill Advance", "0.00"],
  ];
  const mopLabel: Record<string, string> = {
    CASH: "CASH", UPI: "PAYTM", CARD: "BANK TRANSFER", MEMBER_CARD: "PREPAID CARD",
  };
  return (
    <div className="gst-page">
      <aside className="gst-filter">
        <div className="gst-cap">Filters</div>
        <label>From Date : <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To Date : <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="gst-radios">
          <label><input type="radio" name="wise" defaultChecked /> Bill Wise</label>
          <label><input type="radio" name="wise" /> Date Wise</label>
          <label><input type="radio" name="wise" /> Month Wise</label>
        </div>
        <label>Outlet Group: <select className="win"><option>Select</option></select></label>
        <label>Outlet Name: <select className="win"><option>Select</option>{OUTLETS.map((o) => <option key={o}>{o}</option>)}</select></label>
        <label>MOP : <select className="win"><option>Select</option><option>CASH</option><option>UPI</option><option>CARD</option></select></label>
        <label>Account : <select className="win"><option>Select</option></select></label>
        <label>Bill No : <input className="win" /></label>
        <fieldset>
          <legend>Tax Report</legend>
          <label><input type="checkbox" defaultChecked /> All Tax</label>
          <label><input type="checkbox" /> Liquor</label>
          <label><input type="checkbox" /> FnB</label>
        </fieldset>
        <fieldset>
          <legend>Settlement (Multi / Single)</legend>
          <label><input type="checkbox" defaultChecked /> All</label>
          <label><input type="checkbox" /> Single</label>
          <label><input type="checkbox" /> Multi</label>
        </fieldset>
        <label><input type="checkbox" /> Cancel Bill</label>
        <label><input type="checkbox" /> Complementary</label>
        <fieldset>
          <legend>GST Client Details</legend>
          <label><input type="radio" name="cli" defaultChecked /> Not Show</label>
          <label><input type="radio" name="cli" /> Only GST</label>
          <label><input type="radio" name="cli" /> All Client</label>
        </fieldset>
        <label><input type="checkbox" defaultChecked /> Date Apply</label>
        <label><input type="checkbox" /> With Settlement</label>
        <label>Steward Name <select className="win"><option>Select</option></select></label>
        <div className="gst-actions">
          <div className="gst-print-cap">Print</div>
          <button className="fn" onClick={load}>Smaller Printer</button>
          <button className="fn" onClick={load}>Refresh</button>
          <button className="fn">Tax Summery Small Print</button>
          <button className="fn">Export</button>
          <button className="fn">Mail</button>
          <button className="fn" onClick={onExit}>Close</button>
        </div>
      </aside>
      <CrystalChrome onExit={onExit}>
        <div className="cr-paper gst-paper">
          <h1>THE BOSS</h1>
          <h2>GST Summery</h2>
          <div className="cr-meta">From : {dmy(new Date(from))} &nbsp; To : {dmy(new Date(to))}</div>
          <table className="gst-sum">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}><td>{k}</td><td className="dots" /><td className="num">{v}</td></tr>
              ))}
            </tbody>
          </table>
          <table className="gst-sum" style={{ marginTop: 16 }}>
            <thead><tr><th>Particular</th><th /><th>Amount</th></tr></thead>
            <tbody>
              {(d.mop || []).map((m: any) => (
                <tr key={m.method}><td>{mopLabel[m.method] || m.method}</td><td className="dots" /><td className="num">{inr(m.amount)}</td></tr>
              ))}
              {!(d.mop || []).length && <tr><td>CASH</td><td className="dots" /><td className="num">0.00</td></tr>}
            </tbody>
          </table>
        </div>
      </CrystalChrome>
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
  async function load() {
    const data = await api.get<any>(`/api/reports/item-wise?from=${from}&to=${to}`);
    const map = new Map<string, { name: string; sold: number; amount: number; station: string; tax: number }>();
    for (const r of data.rows ?? []) {
      const cur = map.get(r.item_name) || { name: r.item_name, sold: 0, amount: 0, station: r.station, tax: r.tax_rate };
      cur.sold += r.qty;
      cur.amount += r.amount;
      map.set(r.item_name, cur);
    }
    setRows([...map.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }
  useEffect(() => { load().catch(() => null); }, []);
  const groups = useMemo(() => {
    const g: Record<string, typeof rows> = {};
    for (const r of rows) {
      const key = `${r.station === "BAR" ? "BAR" : "FOOD"} @ ${r.tax || 18}%`;
      (g[key] ||= []).push(r);
    }
    return g;
  }, [rows]);
  let sl = 0;
  return (
    <div className="iws-page">
      <div className="rpt-bar wrap">
        <label>Sales Group : <select className="win"><option>Select</option></select></label>
        <label>Item Name : <select className="win"><option>Select</option></select></label>
        <label>Item Group : <select className="win"><option>Select</option></select></label>
        <label>Order By : <select className="win"><option>Order By Item Name</option></select></label>
        <label>BTC : <select className="win"><option>Select</option></select></label>
        <label><input type="checkbox" defaultChecked /> With Tax</label>
        <label>Waiter : <select className="win"><option>Select</option></select></label>
        <label>MOP : <select className="win"><option>Select</option></select></label>
        <label>Card <select className="win"><option>Select</option></select></label>
        <label><input type="checkbox" /> With Out Discount</label>
        <span className="spacer" />
        <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>To</span>
        <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="fn" onClick={load}>Refresh</button>
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
                <th>Slk.</th><th>Item Name</th><th>Complementary</th><th>Sold</th>
                <th>Amount</th><th>Group Total</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(groups).flatMap(([gname, items]) => {
                const tot = items.reduce((s, i) => s + i.amount, 0);
                const head = (
                  <tr key={gname} className="grp">
                    <td /><td colSpan={4}>{gname}</td><td className="num">{inr(tot)}</td>
                  </tr>
                );
                const body = items.map((it) => {
                  sl += 1;
                  return (
                    <tr key={it.name}>
                      <td>{sl}</td>
                      <td>{it.name.toUpperCase()}</td>
                      <td>0</td>
                      <td>{it.sold}</td>
                      <td>{Math.round(it.amount / 100)}</td>
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
        <button className="fn">S.Print</button>
        <button className="fn" onClick={() => window.print()}>Print</button>
        <button className="fn">Export</button>
        <button className="fn" onClick={onExit}>Close</button>
      </div>
    </div>
  );
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

function SettlementUpdateDialog({
  paymentId,
  outlet,
  bills,
  onSwitch,
  onClose,
  onChanged,
}: {
  paymentId: string;
  outlet: string;
  bills: Array<{ payment_id: string; bill_no: string }>;
  onSwitch: (id: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [row, setRow] = useState<any>(null);
  const [mode, setMode] = useState("CASH");
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState("Cash.");
  const [remark, setRemark] = useState("");
  const [err, setErr] = useState("");
  const [askDelete, setAskDelete] = useState(false);
  const amtRef = useRef<HTMLInputElement>(null);
  const remarkRef = useRef<HTMLInputElement>(null);
  const billRef = useRef<HTMLSelectElement>(null);
  const updateRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  const saveRef = useRef<() => void>(() => {});
  close.current = onClose;

  useEffect(() => {
    let gone = false;
    api.get<any>(`/api/reports/settlement/${paymentId}`).then((next) => {
      if (gone) return;
      setRow(next);
      const label = modeLabel(next.method);
      setMode(label);
      setAmount(rupees(next.amount));
      setAccount(label === "CASH" ? (next.account || "Cash.") : label === "BANK TRANSFER" ? (next.account || "Bank payment") : "Prepaid Card");
      setRemark(next.remark || "");
      setErr("");
      if (document.activeElement instanceof HTMLSelectElement) return;
      setTimeout(() => { amtRef.current?.focus(); amtRef.current?.select(); }, 0);
    }).catch((e) => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
  }, [paymentId]);

  async function save() {
    setErr("");
    let paise = 0;
    try { paise = parseRupeesInput(amount || "0"); } catch { setErr("Enter settle amount"); return; }
    if (paise <= 0) { setErr("Enter settle amount"); return; }
    if (!remark.trim()) { setErr("Enter Remark"); return; }
    try {
      const next = await api.put<any>(`/api/reports/settlement/${paymentId}`, { method: mode, amount: paise, account, remark });
      setRow(next);
      setAmount(rupees(next.amount));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    }
  }
  saveRef.current = () => void save();

  async function remove() {
    setAskDelete(false);
    try {
      await api.del(`/api/reports/settlement/${paymentId}`);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  useEffect(() => {
    function fieldOrder() {
      const root = document.querySelector(".su-dlg .su-grid");
      const fields = root ? [...root.querySelectorAll("input, select")] as HTMLElement[] : [];
      return updateRef.current ? [...fields, updateRef.current] : fields;
    }
    function focusField(el: HTMLElement | undefined) {
      if (!el) return;
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
      if (el instanceof HTMLSelectElement) {
        try { el.showPicker(); } catch { /* already open, or this browser will not open it */ }
      }
    }
    function keys(e: KeyboardEvent) {
      if (document.querySelector(".confirm-dlg")) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key === "F2") { e.preventDefault(); e.stopPropagation(); saveRef.current(); return; }
      if (e.key === "F4") { e.preventDefault(); e.stopPropagation(); setAskDelete(true); return; }
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") return;
      if (e.key !== "Enter") return;
      const active = document.activeElement;
      const order = fieldOrder();
      if (!order.length) return;
      const cur = order.indexOf(active as HTMLElement);
      if (e.key === "Enter" && updateRef.current && active === updateRef.current) {
        e.preventDefault();
        e.stopPropagation();
        saveRef.current();
        return;
      }
      if (e.key === "Enter" && active instanceof HTMLSelectElement) {
        const el = order[Math.min(order.length - 1, (cur < 0 ? 0 : cur) + 1)];
        setTimeout(() => focusField(el), 0);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const at = cur < 0 ? 0 : cur;
      focusField(order[Math.min(order.length - 1, at + 1)]);
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, []);

  const accounts = mode === "BANK TRANSFER" ? BANK_ACCOUNTS : mode === "PREPAID CARD" ? ["Prepaid Card"] : ["Cash."];
  const entered = (() => { try { return parseRupeesInput(amount || "0"); } catch { return Number(row?.amount) || 0; } })();
  const balance = Math.max(0, Number(row?.bill_amount || 0) - (Number(row?.paid || 0) - Number(row?.amount || 0) + entered));

  return (
    <div className="su-dlg">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Restaurant Settlement - {outlet}
        <span className="cap-btns">
          <button type="button" tabIndex={-1}>–</button>
          <button type="button" tabIndex={-1}>□</button>
          <button type="button" onClick={onClose}>✕</button>
        </span>
      </div>
      <div className="su-body">
        <div className="su-grid">
          <div className="su-row"><span>Bill No. :</span>
            <span className="su-bill">
              <select ref={billRef} className="win" value={paymentId} onChange={(e) => onSwitch(e.target.value)}>
                {bills.map((b) => <option key={b.payment_id} value={b.payment_id}>{b.bill_no}</option>)}
              </select>
              <button type="button" className="su-more" tabIndex={-1} onClick={() => billRef.current?.focus()}>▾</button>
            </span>
          </div>
          <div className="su-row"><span>Date :</span><input className="win" readOnly value={stampDialog(row?.voucher_date)} /></div>
          <div className="su-row"><span>Guest Name :</span><input className="win" readOnly value={row?.guest || ""} /></div>
          <div className="su-row"><span>Table No :</span><input className="win" readOnly value={row?.table_no || ""} /></div>
          <div className="su-row"><span>Voucher/Receipt :</span><input className="win" readOnly value={row?.receipt_no ?? ""} /></div>
          <div className="su-row"><span>Bill Amount :</span><input className="win" readOnly value={rupees(row?.bill_amount)} /></div>
          <div className="su-row"><span>Allowance :</span><input className="win" readOnly value={rupees(row?.allowance)} /></div>
          <div className="su-row"><span>Payment Mode :</span>
            <select className="win" value={mode} onChange={(e) => {
              const next = e.target.value;
              setMode(next);
              setAccount(next === "CASH" ? "Cash." : next === "PREPAID CARD" ? "Prepaid Card" : (BANK_ACCOUNTS.includes(account) ? account : "Bank payment"));
            }}>
              <option>CASH</option>
              <option>BANK TRANSFER</option>
              <option>PREPAID CARD</option>
            </select>
          </div>
          <div className="su-row"><span>Settled Amount :</span>
            <input ref={amtRef} className="win green" data-num="dec" value={amount} onChange={(e) => setAmount(e.target.value)} onFocus={(e) => e.target.select()} />
          </div>
          <div className="su-row"><span>Cash Account :</span>
            <select className="win" value={accounts.includes(account) ? account : accounts[0]} onChange={(e) => setAccount(e.target.value)}>
              {accounts.map((a) => <option key={a}>{a}</option>)}
            </select>
          </div>
          <div className="su-row"><span>Balance Amount :</span><input className="win" readOnly value={rupees(balance)} /></div>
          <div />
          <div className="su-row"><span>Remark :</span><input ref={remarkRef} className="win" value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
        </div>
        {err && <AlertBox message={err} onClose={() => { setErr(""); if (!remarkRef.current?.value.trim()) remarkRef.current?.focus(); }} />}
        <div className="su-foot">
          <span className="su-vno">Voucher No : {row?.voucher_no ?? ""}</span>
          <button type="button" className="fn" onClick={() => {
            if (!row?.invoice_id) return;
            void api.post(`/api/invoices/${row.invoice_id}/print`).then(async (res) => {
              const { handleBillPrintResponse } = await import("./printBillHtml");
              await handleBillPrintResponse(res as any);
            }).catch(() => null);
          }}>Print</button>
          <button ref={updateRef} type="button" className="fn su-update" onClick={() => void save()}>Update (F2)</button>
          <button type="button" className="fn" onClick={() => setAskDelete(true)}>Delete (F4)</button>
          <button type="button" className="fn" onClick={onClose}>Exit</button>
        </div>
      </div>
      {askDelete && (
        <ConfirmAsk message="Delete this settlement?" onYes={() => void remove()} onNo={() => setAskDelete(false)} />
      )}
    </div>
  );
}

export function SettlementReport({ outlet, onExit }: { outlet?: string; onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [outletName, setOutletName] = useState(outlet || "THE BOSS CLUB");
  const [mop, setMop] = useState("Select");
  const [bill, setBill] = useState("");
  const [account, setAccount] = useState("Select");
  const [user, setUser] = useState("Select");
  const [settled, setSettled] = useState(false);
  const [data, setData] = useState<any>({ rows: [], totals: [], users: [], allowance: 0 });
  const [sel, setSel] = useState<string | null>(null);
  const [col, setCol] = useState(0);
  const [editId, setEditId] = useState<string | null>(null);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  useEffect(() => { setOutletName(outlet || "THE BOSS CLUB"); }, [outlet]);

  async function load(nextOutlet = outletName) {
    const q = new URLSearchParams({
      from, to, outlet: nextOutlet, mop, bill, account, user, settled: settled ? "1" : "0",
    });
    setData(await api.get(`/api/reports/settlement?${q}`));
  }
  useEffect(() => { load(outlet || "THE BOSS CLUB").catch(() => null); }, [outlet]);
  useEffect(() => {
    const rows = data.rows || [];
    if (!rows.length) { setSel(null); return; }
    setSel(rows[rows.length - 1].payment_id);
    setCol(0);
  }, [data]);
  useLayoutEffect(() => {
    const rows = data.rows || [];
    if (!rows.length || sel !== rows[rows.length - 1].payment_id) return;
    const scroller = document.querySelector(".set-grid-wrap") as HTMLElement | null;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    const tr = scroller.querySelector("tbody tr:last-child") as HTMLElement | null;
    tr?.focus({ preventScroll: true });
  }, [data, sel]);
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (editId || document.querySelector(".su-dlg, .alert-dlg, .confirm-dlg")) return;
      const rows = data.rows || [];
      if (!rows.length) return;
      const idx = Math.max(0, rows.findIndex((r: any) => r.payment_id === selRef.current));
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowLeft") setCol((c) => Math.max(0, c - 1));
        if (e.key === "ArrowRight") setCol((c) => Math.min(20, c + 1));
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

  const tot = (m: string) => (data.totals || []).find((t: any) => t.method === m)?.amount || 0;
  const bank = tot("CARD") + tot("UPI");
  const grand = tot("CASH") + bank + tot("MEMBER_CARD");
  const users: string[] = data.users || [];

  return (
    <div className="set-page">
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
              <option>Select</option>
              {users.map((name) => <option key={name}>{name}</option>)}
            </select></label>
            <label className="set-check"><input type="checkbox" checked={settled} onChange={(e) => setSettled(e.target.checked)} /> Settlement</label>
          </div>
        </div>
        <div className="set-btns">
          <button className="fn" onClick={() => void load()}>Show</button>
          <button className="fn" onClick={() => window.print()}>Print</button>
          <button className="fn" onClick={onExit}>Exit</button>
        </div>
      </div>
      <div className="set-grid-wrap">
        <table className="data set-table">
          <thead>
            <tr>
              {["TType","SDid","VoucherRecei","VoucherDate","BillNo","TableNo","RoomTable","Waiter","SettledAmou","Allowance","Remark","MOP","USERNAME","VoucherValu","VoucherNo","status","Min.Diff","OutletName","OutletGroup","OUTLETID","MOP1"].map((h) => <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {(data.rows || []).map((r: any) => {
              const mode = mopCell(r.method, r.account);
              const cells = [
                "SALE", "", r.receipt_no ?? "", stampGrid(r.voucher_date), r.bill_no ?? "",
                r.table_no ?? "", "", r.waiter ?? "", inr(r.settled), inr(r.allowance),
                r.remark || "----", mode, r.username ?? "", inr(r.settled), r.voucher_no ?? "",
                r.status ?? "", "0", r.outlet_name || outletName, "FNB", "", mode,
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
                  }}
                >
                  {cells.map((text, c) => (
                    <td key={c} className={`${[8, 9, 13].includes(c) ? "num" : ""} ${on && c === col ? "cell-on" : ""}`.trim()}>
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
          bills={(data.rows || []).map((r: any) => ({ payment_id: r.payment_id, bill_no: r.bill_no }))}
          onSwitch={setEditId}
          onClose={() => setEditId(null)}
          onChanged={() => { void load(); }}
        />
      )}
    </div>
  );
}

export function BookingReport({ onExit }: { onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>("/api/bookings").then(setRows).catch(() => null); }, []);
  const total = rows.reduce((s, r) => s + (r.advance || 0), 0);
  return (
    <div className="rpt-page plain">
      <div className="rpt-bar">
        <label>Booking No. <input className="win" style={{ width: 80 }} /></label>
        <label>Mobile No : <input className="win" style={{ width: 100 }} /></label>
        <label>User Name: <select className="win"><option>Select</option></select></label>
        <span className="spacer" />
        <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>To</span>
        <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="fn">Refresh</button>
      </div>
      <div className="bkr-title">Card Recharge Data &nbsp; Card against Bill Report</div>
      <table className="data">
        <thead>
          <tr>
            <th>CardNo</th><th>OutletName</th><th>BookingDate</th><th>Total</th>
            <th>Consume_A...</th><th>Balance_Am...</th><th>Cash</th><th>Card</th><th>Wallet</th>
          </tr>
        </thead>
        <tbody>
          <tr className="grp">
            <td>Total :</td><td /><td /><td>{inr(total)}</td><td>0.00</td><td>0</td><td /><td /><td />
          </tr>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.card_no}</td><td>{r.outlet}</td><td>{r.created_at}</td><td>{inr(r.advance)}</td>
              <td>0.00</td><td>0</td><td /><td /><td />
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid-fill gray" />
      <div className="rpt-foot">
        <button className="fn">Print</button>
        <button className="fn">Export</button>
        <button className="fn" onClick={onExit}>Close</button>
      </div>
    </div>
  );
}

export function CardBlock({ onExit }: { onExit: () => void }) {
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [askExit, setAskExit] = useState(false);
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
    try {
      const found = await api.get<any[]>(`/api/cards?q=${encodeURIComponent(q)}`);
      if (!found[0]) { setMsg("Card not found"); return; }
      await api.post(`/api/cards/${found[0].id}/block`, { reason: "Blocked from Card Block" });
      setMsg(`Blocked ${found[0].card_number}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    }
  }
  return (
    <div className="card-block">
      <div className="cb-head">Enter Card No.</div>
      <input className="win cb-input" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="cb-btns">
        <button className="fn" onClick={block}>Block Card</button>
        <button className="fn" onClick={requestExit}>Exit</button>
      </div>
      {msg && <AlertBox message={msg} onClose={() => setMsg("")} />}
    </div>
  );
}

export function AdvanceBooking({ onExit }: { onExit: () => void }) {
  const blank = { cardNo: "", advance: "0.00", outlet: "THE BOSS CLUB", mop: "Select" };
  const [form, setForm] = useState(blank);
  const [no, setNo] = useState(430);
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState(false);
  const [askExit, setAskExit] = useState(false);
  const cardRef = useRef<HTMLInputElement>(null);
  const advanceRef = useRef<HTMLInputElement>(null);
  const outletRef = useRef<HTMLSelectElement>(null);
  const mopRef = useRef<HTMLSelectElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cardRef.current?.focus();
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

  function checkCard() {
    if (!/^\d{4}$/.test(form.cardNo)) return fail("Card No must be 4 digits", cardRef.current);
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

  function setAdvance(raw: string) {
    let s = raw.replace(/[^\d.]/g, "");
    const first = s.indexOf(".");
    if (first >= 0) s = s.slice(0, first + 1) + s.slice(first + 1).replace(/\./g, "");
    const [w, d] = s.split(".");
    s = d != null ? `${w}.${d.slice(0, 2)}` : w;
    setForm({ ...form, advance: s });
  }

  async function save() {
    if (!checkCard() || !checkAdvance()) return;
    try {
      const amt = formatAdvance();
      const row = await api.post<any>("/api/bookings", {
        cardNo: form.cardNo,
        advance: Math.round(Number(amt) * 100),
        outlet: form.outlet,
        mop: form.mop === "Select" ? "" : form.mop,
      });
      setMsg(`Saved reservation ${row.reservation_no}`);
      setNo((row.reservation_no || no) + 1);
      setForm(blank);
      setTimeout(() => cardRef.current?.focus(), 0);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Save failed");
    }
  }

  function clear() {
    setMsg("");
    setOk(false);
    setForm(blank);
    setTimeout(() => cardRef.current?.focus(), 0);
  }

  function isDraft() {
    return form.cardNo.trim() !== "" || (Number(form.advance) > 0 && form.advance !== "0.00");
  }

  function requestExit() {
    if (isDraft()) setAskExit(true);
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
  return (
    <div className="adv-page">
      <aside className="adv-side" />
      <div className="adv-form">
        <div className="adv-top">
          <span>Reservation No : &nbsp; {no}</span>
          <span>Date : {dmy()} {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <label>Card No <input ref={cardRef} className="win green" tabIndex={1} autoFocus inputMode="numeric" maxLength={4} value={form.cardNo} onChange={(e) => setForm({ ...form, cardNo: e.target.value.replace(/\D/g, "").slice(0, 4) })} onKeyDown={onEnter(checkCard, () => advanceRef.current?.focus())} /></label>
        <label>Advance <input ref={advanceRef} className="win" data-num="dec" tabIndex={2} inputMode="decimal" value={form.advance} onChange={(e) => setAdvance(e.target.value)} onFocus={(e) => e.target.select()} onBlur={() => setForm((f) => ({ ...f, advance: formatAdvance(f.advance) }))} onKeyDown={onEnter(() => { const okAmt = checkAdvance(); if (okAmt) setForm((f) => ({ ...f, advance: formatAdvance(f.advance) })); return okAmt; }, () => outletRef.current?.focus())} /></label>
        <label>Outlet <select ref={outletRef} className="win" tabIndex={3} value={form.outlet} onChange={(e) => setForm({ ...form, outlet: e.target.value })} onKeyDown={onEnter(() => true, () => mopRef.current?.focus())}>
          <option>THE BOSS CLUB</option><option>BAR</option><option>RESTAURANT</option><option>NC</option>
        </select></label>
        <label>MOP <span className="mop-row"><select ref={mopRef} className="win" tabIndex={4} value={form.mop} onChange={(e) => setForm({ ...form, mop: e.target.value })} onKeyDown={onEnter(() => true, () => saveRef.current?.focus())}>
          <option>Select</option><option>CASH</option><option>UPI</option><option>CARD</option>
        </select></span></label>
        <button ref={saveRef} className="fn adv-save" tabIndex={5} onClick={() => void save()} onKeyDown={onEnter(() => true, () => void save())}>Save</button>
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

function BillReport({ outlet, onExit }: { outlet?: string; onExit: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const [tick, setTick] = useState(0);
  const [miss, setMiss] = useState("");
  return (
    <>
      <GridReport
        key={tick}
        title="Bill Report"
        endpoint="/api/reports/bills"
        columns={[["invoice_number","Bill No"],["table_no","Table"],["guest","Guest"],["grand_total","Amount"],["status","Status"],["created_at","Date"]]}
        onExit={onExit}
        cellSelect
        onEdit={(row) => {
          if (row.payment_id) setEdit(row);
          else setMiss("No settlement for this bill");
        }}
      />
      {miss && <AlertBox message={miss} onClose={() => setMiss("")} />}
      {edit?.payment_id && (
        <SettlementUpdateDialog
          paymentId={edit.payment_id}
          outlet={edit.outlet_name || outlet || "BAR"}
          bills={[{ payment_id: edit.payment_id, bill_no: String(edit.invoice_number ?? "") }]}
          onSwitch={() => {}}
          onClose={() => setEdit(null)}
          onChanged={() => setTick((n) => n + 1)}
        />
      )}
    </>
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
      await api.post(`/api/kots/${id}/reprint`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Print failed");
    }
  }
  reprintRef.current = () => void reprint();

  useEffect(() => {
    function keys(e: globalThis.KeyboardEvent) {
      if (document.querySelector(".confirm-dlg, .alert-dlg")) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key === "F6") { e.preventDefault(); e.stopPropagation(); reprintRef.current(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        printRef.current?.focus();
        reprintRef.current();
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
        <span className="cap-btns">
          <button type="button" tabIndex={-1}>–</button>
          <button type="button" tabIndex={-1}>□</button>
          <button type="button" onClick={onClose}>✕</button>
        </span>
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
  const [kotKey, setKotKey] = useState<string | null>(null);
  function openRow(row: any) {
    const key = String(row?.id || row?.kot_number || "").trim();
    if (key) setKotKey(key);
  }
  return (
    <>
      <GridReport
        title={`${outlet || ""} KOT Report`.trim()}
        endpoint={`/api/reports/kots${outlet === "BAR" ? "?station=BAR" : outlet ? "?station=KITCHEN" : ""}`}
        columns={[
          ["kot_number", "KOT No"],
          ["manual_kot", "Manual KOTNo"],
          ["table_no", "Table No"],
          ["kot_date", "KOT Date"],
          ["kot_time", "Kot Time"],
          ["bill_no", "BillNo"],
          ["net_amount", "NetAmount"],
          ["steward", "StwardName"],
          ["kot_remark", "KOTRemark"],
          ["user_id", "UserID"],
        ]}
        onExit={onExit}
        cellSelect
        onEdit={openRow}
      />
      {kotKey && (
        <KotAddTableDialog
          kotKey={kotKey}
          onClose={() => setKotKey(null)}
        />
      )}
    </>
  );
}

export function ReportHost({ view, outlet, onExit }: { view: NavView; outlet?: string; onExit: () => void }) {
  if (view === "item-wise-detail") return <ItemWiseDetail onExit={onExit} />;
  if (view === "point-of-sales") return <PointOfSales onExit={onExit} />;
  if (view === "gst-report") return <GstReport onExit={onExit} />;
  if (view === "item-wise-sale") return <ItemWiseSale onExit={onExit} />;
  if (view === "settlement-report") return <SettlementReport outlet={outlet} onExit={onExit} />;
  if (view === "booking-report") return <BookingReport onExit={onExit} />;
  if (view === "card-block") return <CardBlock onExit={onExit} />;
  if (view === "advance-booking") return <AdvanceBooking onExit={onExit} />;
  if (view === "kot-report") return <KotReport outlet={outlet} onExit={onExit} />;
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
  return null;
}
