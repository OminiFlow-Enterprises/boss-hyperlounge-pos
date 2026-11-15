import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { NavView } from "../shared/types";

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

export function GridReport({ title, endpoint, columns, onExit }: {
  title: string; endpoint: string; columns: Array<[string, string]>; onExit: () => void;
}) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [rows, setRows] = useState<any[]>([]);
  async function load() {
    const join = endpoint.includes("?") ? "&" : "?";
    const data = await api.get<any>(endpoint.includes("/inventory") ? endpoint : `${endpoint}${join}from=${from}&to=${to}`);
    setRows(Array.isArray(data) ? data : (data.rows ?? []));
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
              <tr key={i}>{columns.map(([k]) => <td key={k}>{typeof r[k] === "number" && k.includes("total") || k === "grand_total" || k === "amount" ? inr(r[k]) : String(r[k] ?? "")}</td>)}</tr>
            ))}
            {!rows.length && <tr><td colSpan={columns.length} className="empty">No records</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SettlementReport({ outlet, onExit }: { outlet?: string; onExit: () => void }) {
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [data, setData] = useState<any>({ rows: [], totals: [] });
  async function load() {
    setData(await api.get(`/api/reports/settlement?from=${from}&to=${to}&outlet=${encodeURIComponent(outlet || "THE BOSS CLUB")}`));
  }
  useEffect(() => { load().catch(() => null); }, []);
  const tot = (m: string) => (data.totals || []).find((t: any) => t.method === m)?.amount || 0;
  const grand = (data.totals || []).reduce((s: number, t: any) => s + t.amount, 0);
  return (
    <div className="set-page">
      <div className="set-filter">
        <div className="set-grid">
          <b>Select Filter</b>
          <span />
          <label>Outlet : <input className="win" value={outlet || "THE BOSS CLUB"} readOnly /></label>
          <label>Date From : <input className="win" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>MOP : <select className="win"><option>Select</option><option>CASH</option><option>UPI</option><option>CARD</option></select></label>
          <div className="set-btns">
            <button className="fn" onClick={load}>Show</button>
            <button className="fn" onClick={() => window.print()}>Print</button>
            <button className="fn" onClick={onExit}>Exit</button>
          </div>
          <label>Bill No. : <input className="win" /></label>
          <label>To Date : <input className="win" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label>Accounts : <select className="win"><option /></select></label>
          <label>User : <select className="win"><option>Select</option></select></label>
          <label><input type="checkbox" /> Settlement</label>
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
            {(data.rows || []).map((r: any, i: number) => (
              <tr key={i}>
                <td>SALE</td><td /><td /><td>{r.voucher_date}</td><td>{r.bill_no}</td>
                <td>{r.table_no}</td><td /><td /><td>{inr(r.settled)}</td><td>{inr(r.allowance)}</td>
                <td /><td>{r.mop}</td><td>{r.username}</td><td>{inr(r.settled)}</td><td>{r.bill_no}</td>
                <td>{r.status}</td><td>0</td><td>{outlet || "THE BOSS CLUB"}</td><td>FNB</td><td /><td>{r.mop}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="set-totals">
        <label>Total Cash : <input className="win" readOnly value={rupees(tot("CASH"))} /></label>
        <label>Cheque/D.D. : <input className="win" readOnly value="0.00" /></label>
        <label>Credit Card : <input className="win" readOnly value={rupees(tot("CARD"))} /></label>
        <label>B.T.C. : <input className="win" readOnly value="0.00" /></label>
        <label>Room Credit : <input className="win" readOnly value="0.00" /></label>
        <label>Bank Transfer : <input className="win" readOnly value={rupees(tot("UPI"))} /></label>
        <label>Wallet : <input className="win" readOnly value="0.00" /></label>
        <label>Allowance : <input className="win" readOnly value="0.00" /></label>
        <label>Prepaid Card : <input className="win" readOnly value={rupees(tot("MEMBER_CARD"))} /></label>
        <label>Total Amount : <input className="win" readOnly value={rupees(grand)} /></label>
      </div>
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
        <button className="fn" onClick={onExit}>Exit</button>
      </div>
      {msg && <p className="meta" style={{ padding: 8 }}>{msg}</p>}
    </div>
  );
}

export function AdvanceBooking({ onExit }: { onExit: () => void }) {
  const [form, setForm] = useState({ mobile: "", guestName: "", cardNo: "", advance: "", outlet: "THE BOSS CLUB", mop: "Select" });
  const [no, setNo] = useState(430);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.get<any[]>("/api/bookings").then((rows) => {
      const max = rows.reduce((m, r) => Math.max(m, r.reservation_no || 0), 429);
      setNo(max + 1);
    }).catch(() => null);
  }, []);
  async function save() {
    const row = await api.post<any>("/api/bookings", {
      ...form,
      advance: Math.round(Number(form.advance || 0) * 100),
      mop: form.mop === "Select" ? "" : form.mop,
    });
    const bal = row.balances?.usable != null ? (row.balances.usable / 100).toFixed(2) : form.advance;
    setMsg(`Saved reservation ${row.reservation_no} · Card ${form.cardNo} balance ${bal}`);
    setNo(row.reservation_no + 1);
    setForm({ mobile: "", guestName: "", cardNo: "", advance: "", outlet: "THE BOSS CLUB", mop: "Select" });
  }
  return (
    <div className="adv-page">
      <aside className="adv-side" />
      <div className="adv-form">
        <div className="adv-top">
          <span>Reservation No : &nbsp; {no}</span>
          <span>Date : {dmy()} {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <label>Mobile No <input className="win green" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} /></label>
        <label>Guest Name <input className="win" value={form.guestName} onChange={(e) => setForm({ ...form, guestName: e.target.value })} /></label>
        <label>Card No <input className="win" value={form.cardNo} onChange={(e) => setForm({ ...form, cardNo: e.target.value })} /></label>
        <label>Advance <input className="win" value={form.advance} onChange={(e) => setForm({ ...form, advance: e.target.value })} /></label>
        <label>Outlet <select className="win" value={form.outlet} onChange={(e) => setForm({ ...form, outlet: e.target.value })}>
          <option>THE BOSS CLUB</option><option>BAR</option><option>RESTAURANT</option><option>NC</option>
        </select></label>
        <label>MOP <span className="mop-row"><select className="win" value={form.mop} onChange={(e) => setForm({ ...form, mop: e.target.value })}>
          <option>Select</option><option>CASH</option><option>UPI</option><option>CARD</option>
        </select></span></label>
        <button className="fn adv-save" onClick={save}>Save</button>
        {msg && <p className="ok">{msg}</p>}
      </div>
      <div className="adv-foot">
        <button className="fn">Clear/New</button>
        <button className="fn" onClick={onExit}>Exit</button>
      </div>
    </div>
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
  if (view === "kot-report") {
    return (
      <GridReport
        title={`${outlet || ""} KOT Report`.trim()}
        endpoint={`/api/reports/kots${outlet === "BAR" ? "?station=BAR" : outlet ? "?station=KITCHEN" : ""}`}
        columns={[["kot_number","KOT"],["table_no","Table"],["station","Station"],["status","Status"],["items","Items"],["created_at","Date"]]}
        onExit={onExit}
      />
    );
  }
  if (view === "bill-report" || view === "history") {
    return (
      <GridReport
        title="Bill Report"
        endpoint="/api/reports/bills"
        columns={[["invoice_number","Bill No"],["table_no","Table"],["guest","Guest"],["grand_total","Amount"],["status","Status"],["created_at","Date"]]}
        onExit={onExit}
      />
    );
  }
  if (view === "item-combine-stock" || view === "outlet-stock") {
    return (
      <GridReport
        title={view === "outlet-stock" ? "Outlet Wise Stock Report" : "Item Combine Stock Report"}
        endpoint="/api/inventory"
        columns={[["name","Item"],["station","Outlet"],["quantity","Qty"]]}
        onExit={onExit}
      />
    );
  }
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
