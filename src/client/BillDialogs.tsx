import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, ApiError } from "./api";
import { formatINR, parseRupeesInput } from "../shared/money";
import type { PaymentMode } from "../shared/types";

type Table = { id: string; code: string; status: string; customer_name?: string; running_total?: number; outlet?: string };
type Card = { id: string; card_number: string };

const PAY_MODES: Array<{ id: PaymentMode; label: string }> = [
  { id: "CASH", label: "CASH" },
  { id: "CARD", label: "BANK TRANSFER" },
  { id: "MEMBER_CARD", label: "PREPAID CARD" },
];

const BANK_NAMES = [
  "Bank payment",
  "BOOK MY SHOW",
  "COUPON",
  "DINEOUT",
  "DISTRICT",
  "EAZYDINNER",
  "HDFC",
  "PAYTM",
  "ZOMATO",
  "PARTYPAL",
  "INDUS",
  "MOBIKWIK",
];

function rupee(n: number) {
  return (n / 100).toFixed(2);
}

function insufficientCard(e: unknown) {
  if (e instanceof ApiError && e.details && typeof e.details === "object" && e.details !== null && "available" in e.details) {
    const available = Number((e.details as { available: number }).available) || 0;
    return `Insufficient amount  Card balance : ${rupee(available)}`;
  }
  if (e instanceof Error && /INSUFFICIENT/i.test(e.message)) return "Insufficient amount";
  return e instanceof Error ? e.message : "Payment failed";
}

export function PrepareTablePick({
  tables,
  title = "Prepare Bill",
  onPick,
  onClose,
}: {
  tables: Table[];
  title?: string;
  onPick: (t: Table) => void;
  onClose: () => void;
}) {
  const [pick, setPick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      const f11 = e.key === "F11" || e.code === "F11" || e.keyCode === 122;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === "ArrowDown") { e.preventDefault(); setPick((p) => Math.min(tables.length - 1, p + 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setPick((p) => Math.max(0, p - 1)); }
      if (e.key === "Enter" || f11) {
        e.preventDefault();
        e.stopPropagation();
        const t = tables[pick];
        if (t) onPick(t);
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [pick, tables, onPick, onClose]);

  return (
    <div className="prep-pick" role="listbox" ref={box} tabIndex={-1}>
      <div className="prep-pick-cap">{title}</div>
      {tables.map((t, i) => (
        <div
          key={t.id}
          className={`prep-pick-row ${i === pick ? "on" : ""}`}
          onMouseEnter={() => setPick(i)}
          onClick={() => onPick(t)}
        >
          {t.code}
        </div>
      ))}
    </div>
  );
}

export function PrepareBillDialog({
  orderId,
  table,
  outlet,
  waiter,
  guest,
  mobile,
  onClose,
  onPrinted,
  onMessage,
}: {
  orderId: string;
  table: Table;
  outlet: string;
  waiter: string;
  guest: string;
  mobile: string;
  onClose: () => void;
  onPrinted: (invoice: any) => void;
  onMessage: (m: string) => void;
}) {
  const [bill, setBill] = useState<any>(null);
  const [discPct, setDiscPct] = useState("0.00");
  const [svcPct, setSvcPct] = useState("5");
  const [delivery, setDelivery] = useState("0");
  const [name, setName] = useState(guest);
  const [mob, setMob] = useState(mobile);
  const [pax, setPax] = useState("1");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [remark, setRemark] = useState("");
  const [comp, setComp] = useState(false);
  const [rowSel, setRowSel] = useState(0);
  const discRef = useRef<HTMLInputElement>(null);
  const printRef = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);

  async function load(next?: { discountPct?: number; serviceChargePct?: number; otherCharges?: number }) {
    const preview = await api.post<any>("/api/invoices/preview", {
      orderId,
      discountPct: next?.discountPct ?? (Number(discPct) || 0),
      serviceChargePct: next?.serviceChargePct ?? (Number(svcPct) || 0),
      otherCharges: Math.round((Number(next?.otherCharges ?? delivery) || 0) * 100),
    });
    setBill(preview);
    if (next?.serviceChargePct == null && preview.serviceChargePct != null && discPct === "0.00" && !bill) {
      setSvcPct(String(preview.serviceChargePct));
    }
    return preview;
  }

  useEffect(() => {
    load().then(() => setTimeout(() => discRef.current?.focus(), 0)).catch((e) => onMessage(e.message));
  }, [orderId]);

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === "F10") { e.preventDefault(); e.stopPropagation(); void printBill(); }
      if (e.key === "F5") { e.preventDefault(); e.stopPropagation(); void printBill(false); }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  async function printBill(print = true) {
    if (busy.current) return;
    busy.current = true;
    try {
      const invoice = await api.post<any>("/api/invoices/generate", {
        orderId,
        discountPct: Number(discPct) || 0,
        serviceChargePct: Number(svcPct) || 0,
        otherCharges: Math.round((Number(delivery) || 0) * 100),
        reason: remark || undefined,
      });
      if (print) await api.post(`/api/invoices/${invoice.id}/print`).catch(() => null);
      onPrinted(invoice);
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not print bill");
    } finally {
      busy.current = false;
    }
  }

  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, "0")}-${now.toLocaleString("en-GB", { month: "short" })}-${now.getFullYear()}`;
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="dialog bill-dlg">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Restaurant Bill - {outlet}
        <span className="cap-btns">
          <button type="button" tabIndex={-1}>–</button>
          <button type="button" tabIndex={-1}>□</button>
          <button type="button" onClick={onClose}>✕</button>
        </span>
      </div>
      <div className="bill-body">
        <div className="bh">
          <div className="bh-row">
            <span className="bh-k">Table No. :</span>
            <select className="win bh-table" value={table.code} onChange={() => undefined}>
              <option>{table.code}</option>
            </select>
            <span className="bh-k2">Name :</span>
            <label className="chk"><input type="checkbox" /> A/C</label>
            <input className="win bh-name" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="button" className="fn bh-plus">+</button>
            <span className="bh-k3">Pax :</span>
            <input className="win bh-pax" value={pax} onChange={(e) => setPax(e.target.value)} />
          </div>
          <div className="bh-row">
            <span className="bh-k">Bill No. :</span>
            <input className="win bh-table" value={bill?.invoice_number ?? ""} readOnly />
            <span className="bh-k2">Mobile No. :</span>
            <input className="win bh-wide" value={mob} onChange={(e) => setMob(e.target.value)} />
          </div>
          <div className="bh-row">
            <span className="bh-k">Date :</span>
            <input className="win bh-date" value={dateStr} readOnly />
            <input className="win bh-time" value={timeStr} readOnly />
            <span className="bh-k2">GSTIN :</span>
            <input className="win bh-wide" value={gstin} onChange={(e) => setGstin(e.target.value)} />
          </div>
          <div className="bh-row">
            <span className="bh-k" />
            <label className="chk bh-comp"><input type="checkbox" checked={comp} onChange={(e) => setComp(e.target.checked)} /> I want make this complimentary</label>
            <span className="bh-k2">Address :</span>
            <input className="win bh-wide" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div className="bh-row">
            <span className="bh-k">Steward :</span>
            <input className="win bh-table" value={waiter} readOnly />
          </div>
        </div>

        <div className="bill-grid-wrap">
          <table className="bill-grid">
            <colgroup>
              <col className="c-sr" /><col /><col className="c-qty" /><col className="c-price" /><col className="c-tax" /><col className="c-amt" /><col className="c-ck" />
            </colgroup>
            <thead>
              <tr>
                <th>Sr.No.</th><th>ItemName</th><th>Qty</th><th>ItemPrice</th><th>Tax(%)</th><th>Amount</th><th />
              </tr>
            </thead>
            <tbody>
              {(bill?.items ?? []).map((it: any, i: number) => (
                <tr key={it.id} className={i === rowSel ? "on" : ""} onClick={() => setRowSel(i)}>
                  <td>{String(i + 1).padStart(2, "0")}</td>
                  <td>{it.name}</td>
                  <td>{Number(it.qty).toFixed(2)}</td>
                  <td>{rupee(it.unit_price)}</td>
                  <td>{Number(it.tax_rate).toFixed(2)}</td>
                  <td>{rupee(it.amount)}</td>
                  <td><input type="checkbox" tabIndex={-1} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bf">
          <div className="bf-l">
            <div className="bf-row"><span>Total Qty :</span><input className="win" readOnly value={bill?.totalQty ?? 0} /></div>
            <div className="bf-row"><span>Adv. Booking No. :</span><input className="win" /></div>
            <div className="bf-row"><span>Promocode Visit ID :</span><input className="win" /></div>
            <div className="bf-row"><span>Point Redeem :</span><input className="win" defaultValue="0.00" /></div>
            <div className="bf-row"><span>Verify By :</span><input className="win" /></div>
            <div className="bf-row"><span>Offer By :</span><input className="win" /></div>
            <div className="bf-row"><span>Remark :</span><input className="win" value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
          </div>
          <div className="bf-r">
            <div className="bf-row"><span>Total Amount :</span><input className="win" readOnly value={rupee((bill?.foodTotal ?? 0) + (bill?.drinksTotal ?? 0))} /></div>
            <div className="bf-row"><span>Discount (%) :</span>
              <input
                ref={discRef}
                className="win green"
                value={discPct}
                onChange={(e) => setDiscPct(e.target.value)}
                onBlur={() => void load()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void load().then(() => printRef.current?.focus());
                  }
                }}
              />
            </div>
            <div className="bf-row"><span>Service Charges :</span>
              <input className="win svc-pct" value={svcPct} onChange={(e) => setSvcPct(e.target.value)} onBlur={() => void load()} />
              <span>%</span>
              <input className="win" readOnly value={rupee(bill?.serviceCharge ?? 0)} />
            </div>
            <div className="bf-row"><span>Tax Amount :</span><input className="win" readOnly value={rupee(bill?.tax ?? 0)} /></div>
            <div className="bf-row"><span>Delivery Charge :</span><input className="win" value={delivery} onChange={(e) => setDelivery(e.target.value)} onBlur={() => void load()} /></div>
            <div className="bf-row"><span>Round Off :</span><input className="win" readOnly value={rupee(bill?.roundOff ?? 0)} /></div>
            <div className="bf-row"><span>Net Amount :</span><input className="win" readOnly value={Math.round((bill?.grandTotal ?? 0) / 100)} /></div>
          </div>
        </div>

        <div className="bill-btns">
          <button ref={printRef} type="button" className="fn" onClick={() => void printBill(true)} onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void printBill(true); }
          }}>Print Bill (F10)</button>
          <button type="button" className="fn" onClick={() => void printBill(false)}>Save (F5)</button>
          <button type="button" className="fn" onClick={() => void load()}>Print Estimate</button>
          <button type="button" className="fn">Share Bill</button>
          <button type="button" className="fn" onClick={onClose}>Exit</button>
        </div>
      </div>
    </div>
  );
}

export function SettleDialog({
  invoiceId,
  table,
  outlet,
  cardNo,
  onClose,
  onDone,
  onMessage,
}: {
  invoiceId: string;
  table: Table;
  outlet: string;
  cardNo: string;
  onClose: () => void;
  onDone: () => void;
  onMessage: (m: string) => void;
}) {
  const [snap, setSnap] = useState<any>(null);
  const [method, setMethod] = useState<PaymentMode>("CASH");
  const [amount, setAmount] = useState("");
  const [remark, setRemark] = useState("");
  const [payCard, setPayCard] = useState(cardNo);
  const [payBal, setPayBal] = useState("");
  const [bankName, setBankName] = useState("");
  const amtRef = useRef<HTMLInputElement>(null);
  const payCardRef = useRef<HTMLInputElement>(null);
  const bankRef = useRef<HTMLSelectElement>(null);
  const modeRef = useRef<HTMLSelectElement>(null);
  const busy = useRef(false);

  function dueOf(data: any) {
    return Number(data?.due ?? 0);
  }

  async function load() {
    const data = await api.get<any>(`/api/invoices/${invoiceId}`);
    setSnap(data);
    setAmount(rupee(dueOf(data)));
    setTimeout(() => { amtRef.current?.focus(); amtRef.current?.select(); }, 0);
    return data;
  }

  useEffect(() => { load().catch((e) => onMessage(e.message)); }, [invoiceId]);

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === "F2") { e.preventDefault(); e.stopPropagation(); void save(); }
      if (e.key === "F4") { e.preventDefault(); e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  async function save() {
    if (busy.current || !snap) return;
    const due = dueOf(snap);
    let paise = 0;
    try { paise = parseRupeesInput(amount || "0"); } catch { onMessage("Enter settle amount"); return; }
    if (paise <= 0) { onMessage("Enter settle amount"); return; }
    if (paise > due) paise = due;
    if (method === "CARD" && !bankName) {
      onMessage("Select bank name");
      bankRef.current?.focus();
      return;
    }
    const cardRaw = payCard.trim();
    if (method === "MEMBER_CARD" && !cardRaw) {
      onMessage("Enter Card No");
      payCardRef.current?.focus();
      return;
    }
    busy.current = true;
    try {
      let memberCardId: string | undefined;
      if (method === "MEMBER_CARD") {
        const found = await api.get<Card[]>(`/api/cards?q=${encodeURIComponent(cardRaw)}`);
        memberCardId = found[0]?.id;
        if (!memberCardId) {
          onMessage("Card not found");
          payCardRef.current?.focus();
          busy.current = false;
          return;
        }
        try {
          const b = await api.get<any>(`/api/cards/balance/check?q=${encodeURIComponent(cardRaw)}`);
          const usable = Number(b.balances?.usable ?? 0);
          setPayBal(rupee(usable));
          if (usable < paise) {
            onMessage(`Insufficient amount  Card balance : ${rupee(usable)}`);
            busy.current = false;
            return;
          }
        } catch {
          onMessage("Card not found");
          busy.current = false;
          return;
        }
      }
      const result = await api.post<any>(`/api/invoices/${invoiceId}/pay`, {
        lines: [{
          method,
          amount: paise,
          memberCardId,
          reference: method === "CARD" ? bankName : (remark || undefined),
        }],
        printReceipt: false,
      });
      if (result.complete) {
        onDone();
        return;
      }
      setSnap(result);
      setAmount(rupee(Number(result.due ?? 0)));
      onMessage(`Balance ${formatINR(Number(result.due ?? 0))}`);
      setTimeout(() => { amtRef.current?.focus(); amtRef.current?.select(); }, 0);
    } catch (e) {
      onMessage(insufficientCard(e));
    } finally {
      busy.current = false;
    }
  }

  const inv = snap?.invoice;
  const due = dueOf(snap);
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, "0")}-${now.toLocaleString("en-GB", { month: "short" })}-${now.getFullYear()} ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

  return (
    <div className="dialog settle-dlg">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Restaurant Settlement - {outlet}
        <span className="cap-btns">
          <button type="button" tabIndex={-1}>–</button>
          <button type="button" tabIndex={-1}>□</button>
          <button type="button" onClick={onClose}>✕</button>
        </span>
      </div>
      <div className="settle-body">
        <div className="st-grid">
          <div className="st-row"><span>Bill No. :</span><input className="win" readOnly value={inv?.invoice_number ?? ""} /></div>
          <div className="st-row"><span>Date :</span><input className="win" readOnly value={dateStr} /></div>
          <div className="st-row"><span>Guest Name :</span><input className="win" readOnly value={table.customer_name ?? inv?.customer_name ?? ""} /></div>
          <div className="st-row"><span>Table No :</span><input className="win" readOnly value={table.code} /></div>
          <div className="st-row"><span>Voucher/Receipt :</span><input className="win" readOnly value={inv?.invoice_number?.replace(/\D/g, "") ?? ""} /></div>
          <div className="st-row"><span>Bill Amount :</span><input className="win" readOnly value={rupee(inv?.grand_total ?? 0)} /></div>
          <div className="st-row"><span>Allowance :</span><input className="win" readOnly value={rupee(inv?.discount ?? 0)} /></div>
          <div className="st-row"><span>Payment Mode :</span>
            <select
              ref={modeRef}
              className="win"
              value={method}
              onChange={(e) => {
                const next = e.target.value as PaymentMode;
                setMethod(next);
                setTimeout(() => {
                  amtRef.current?.focus();
                  amtRef.current?.select();
                }, 0);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                amtRef.current?.focus();
                amtRef.current?.select();
              }}
            >
              {PAY_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div className="st-row"><span>Settled Amount :</span>
            <input
              ref={amtRef}
              className="win green"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (method === "CARD") {
                  if (!bankName) { bankRef.current?.focus(); return; }
                }
                if (method === "MEMBER_CARD" && !payCard.trim()) {
                  payCardRef.current?.focus();
                  return;
                }
                void save();
              }}
            />
          </div>
          {method === "CARD" && (
            <div className="st-row"><span>Bank Name :</span>
              <select
                ref={bankRef}
                className="win"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (!bankName) { onMessage("Select bank name"); return; }
                  void save();
                }}
              >
                <option value="">Select</option>
                {BANK_NAMES.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          )}
          {method === "MEMBER_CARD" && (
            <div className="st-row"><span>Card No. :</span>
              <input
                ref={payCardRef}
                className="win green"
                value={payCard}
                onChange={(e) => setPayCard(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const q = payCard.trim();
                  if (!q) { onMessage("Enter Card No"); return; }
                  void api.get<any>(`/api/cards/balance/check?q=${encodeURIComponent(q)}`).then((b) => {
                    setPayBal(rupee(Number(b.balances?.usable ?? 0)));
                    void save();
                  }).catch(() => {
                    setPayBal("");
                    onMessage("Card not found");
                  });
                }}
              />
              {payBal ? <span className="st-bal">{payBal}</span> : null}
            </div>
          )}
          <div className="st-row"><span>Balance Amount :</span><input className="win" readOnly value={rupee(due)} /></div>
          <div className="st-row span2"><span>Remark :</span><input className="win" value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
        </div>
        <div className="bill-btns">
          <span className="st-vno">Voucher No</span>
          <button type="button" className="fn" onClick={() => api.post(`/api/invoices/${invoiceId}/print`).catch(() => null)}>Print</button>
          <button type="button" className="fn" onClick={() => void save()}>Save (F2)</button>
          <button type="button" className="fn" onClick={onClose}>Cancel (F4)</button>
          <button type="button" className="fn" onClick={onClose}>Exit</button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmAsk({
  message = "Exit without save?",
  onYes,
  onNo,
}: {
  message?: string;
  onYes: () => void;
  onNo: () => void;
}) {
  const yesRef = useRef<HTMLButtonElement>(null);
  const yes = useRef(onYes);
  const no = useRef(onNo);
  yes.current = onYes;
  no.current = onNo;
  useEffect(() => {
    yesRef.current?.focus();
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        e.stopPropagation();
        no.current();
      }
      if (e.key === "Enter" || e.key === "y" || e.key === "Y") {
        e.preventDefault();
        e.stopPropagation();
        yes.current();
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, []);
  return (
    <div className="dialog confirm-dlg">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Confirm
        <span className="cap-btns"><button type="button" onClick={onNo}>✕</button></span>
      </div>
      <div className="dialog-body">
        <p>{message}</p>
        <div className="bill-btns">
          <button ref={yesRef} type="button" className="fn" onClick={onYes}>Yes</button>
          <button type="button" className="fn" onClick={onNo}>No</button>
        </div>
      </div>
    </div>
  );
}

export function TransferDialog({
  tables,
  outlet,
  currentCode,
  onClose,
  onDone,
  onMessage,
}: {
  tables: Table[];
  outlet: string;
  currentCode: string;
  onClose: () => void;
  onDone: (fromCode: string, to: Table) => void;
  onMessage: (m: string) => void;
}) {
  const [dept, setDept] = useState(outlet === "THE BOSS CLUB" ? "THE BOSS CLUB" : outlet || "BAR");
  const [fromCode, setFromCode] = useState(currentCode);
  const [toCode, setToCode] = useState("");
  const [reason, setReason] = useState("");
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const xferRef = useRef<HTMLButtonElement>(null);
  const occupied = tables.filter((t) => t.status !== "AVAILABLE" && (t.outlet || "BAR") === dept);

  useEffect(() => {
    const running = currentCode && occupied.some((t) => t.code.toLowerCase() === currentCode.trim().toLowerCase());
    const el = running ? toRef.current : fromRef.current;
    el?.focus();
    el?.select();
  }, [currentCode]);

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [onClose]);

  function onEnter(next: () => void) {
    return (e: ReactKeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      next();
    };
  }

  function findRunning(code: string) {
    const raw = code.trim().toLowerCase();
    if (!raw) return undefined;
    return occupied.find((t) => t.code.toLowerCase() === raw);
  }

  function acceptCurrent() {
    if (!fromCode.trim()) {
      onMessage("Enter Current Table No");
      fromRef.current?.focus();
      return undefined;
    }
    const from = findRunning(fromCode);
    if (!from) {
      onMessage("Table No not found");
      fromRef.current?.focus();
      fromRef.current?.select();
      return undefined;
    }
    onMessage("");
    return from;
  }

  async function transfer() {
    const from = acceptCurrent();
    if (!from) return;
    const toRaw = toCode.trim();
    if (!toRaw) { onMessage("Enter New Table No"); toRef.current?.focus(); return; }
    if (from.code.toLowerCase() === toRaw.toLowerCase()) { onMessage("Cannot transfer a table to itself"); return; }
    try {
      let to = tables.find((t) => t.code.toLowerCase() === toRaw.toLowerCase() && (t.outlet || "BAR") === dept);
      if (!to) to = await api.post<Table>("/api/tables", { code: toRaw, name: `Table ${toRaw}`, outlet: dept });
      await api.post("/api/tables/transfer", { fromTableId: from.id, toTableId: to.id, reason: reason.trim() || undefined });
      onDone(from.code, to);
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Transfer failed");
    }
  }

  return (
    <div className="xfer-dlg">
      <div className="xfer-form">
        <div className="xfer-row xfer-outlet">
          <span>Outlet :</span>
          <select className="win" value={dept} onChange={(e) => setDept(e.target.value)} onKeyDown={onEnter(() => fromRef.current?.focus())}>
            <option>BAR</option>
            <option>RESTAURANT</option>
            <option>NC</option>
            <option>THE BOSS CLUB</option>
          </select>
        </div>
        <div className="xfer-row">
          <span>Current Table No :</span>
          <input
            ref={fromRef}
            className="win green"
            list="xfer-from"
            value={fromCode}
            onChange={(e) => setFromCode(e.target.value)}
            onKeyDown={onEnter(() => { if (acceptCurrent()) toRef.current?.focus(); })}
          />
          <datalist id="xfer-from">
            {occupied.map((t) => <option key={t.id} value={t.code} />)}
          </datalist>
          <span>New Table No :</span>
          <input
            ref={toRef}
            className="win"
            list="xfer-to"
            value={toCode}
            onChange={(e) => setToCode(e.target.value)}
            onKeyDown={onEnter(() => reasonRef.current?.focus())}
          />
          <datalist id="xfer-to">
            {tables.filter((t) => t.status === "AVAILABLE" && (t.outlet || "BAR") === dept).map((t) => <option key={t.id} value={t.code} />)}
          </datalist>
        </div>
        <div className="xfer-row">
          <span>Reason :</span>
          <input
            ref={reasonRef}
            className="win xfer-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={onEnter(() => xferRef.current?.focus())}
          />
        </div>
      </div>
      <div className="xfer-btns">
        <button ref={xferRef} type="button" className="fn" onClick={() => void transfer()} onKeyDown={onEnter(() => void transfer())}>Transfer</button>
        <button type="button" className="fn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

type XferItem = {
  id: string;
  name: string;
  qty: number;
  unit_price: number;
  sku: string;
  kot_number: string;
};

export function ItemTransferDialog({
  tables,
  outlet,
  currentCode,
  onClose,
  onDone,
  onMessage,
}: {
  tables: Table[];
  outlet: string;
  currentCode: string;
  onClose: () => void;
  onDone: (fromCode: string, to: Table, sourceClosed: boolean) => void;
  onMessage: (m: string) => void;
}) {
  const [fromCode, setFromCode] = useState(currentCode);
  const [toCode, setToCode] = useState("");
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<XferItem[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState(0);
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const xferRef = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const occupied = tables.filter((t) => t.status !== "AVAILABLE" && (t.outlet || "BAR") === outlet);

  function findRunning(code: string) {
    const raw = code.trim().toLowerCase();
    if (!raw) return undefined;
    return occupied.find((t) => t.code.toLowerCase() === raw);
  }

  async function loadItems(code: string) {
    const from = findRunning(code);
    if (!from) {
      setRows([]);
      setChecked({});
      setSel(0);
      return false;
    }
    try {
      const list = await api.get<XferItem[]>(`/api/tables/${from.id}/items`);
      setRows(list);
      setChecked({});
      setSel(0);
      return true;
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not load items");
      return false;
    }
  }

  function acceptCurrent() {
    if (!fromCode.trim()) {
      onMessage("Enter Current Table No");
      fromRef.current?.focus();
      return undefined;
    }
    const from = findRunning(fromCode);
    if (!from) {
      onMessage("Table No not found");
      fromRef.current?.focus();
      fromRef.current?.select();
      setRows([]);
      setChecked({});
      setSel(0);
      return undefined;
    }
    onMessage("");
    void loadItems(from.code);
    return from;
  }

  useEffect(() => {
    const running = currentCode && findRunning(currentCode);
    const el = running ? toRef.current : fromRef.current;
    el?.focus();
    el?.select();
    if (running) void loadItems(currentCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCode]);

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" && rows.length) {
        e.preventDefault();
        setSel((i) => Math.min(rows.length - 1, i + 1));
      }
      if (e.key === "ArrowUp" && rows.length) {
        e.preventDefault();
        setSel((i) => Math.max(0, i - 1));
      }
      if (e.key === " " && rows.length) {
        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return;
        e.preventDefault();
        const id = rows[sel]?.id;
        if (id) setChecked((c) => ({ ...c, [id]: !c[id] }));
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [onClose, rows, sel]);

  function onEnter(next: () => void) {
    return (e: ReactKeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      next();
    };
  }

  function toggle(id: string) {
    setChecked((c) => ({ ...c, [id]: !c[id] }));
  }

  async function transfer() {
    if (busy.current) return;
    const from = acceptCurrent();
    if (!from) return;
    const toRaw = toCode.trim();
    if (!toRaw) { onMessage("Enter New Table No"); toRef.current?.focus(); return; }
    if (from.code.toLowerCase() === toRaw.toLowerCase()) { onMessage("Cannot transfer items to the same table"); return; }
    const itemIds = rows.filter((r) => checked[r.id]).map((r) => r.id);
    if (!itemIds.length) { onMessage("Select items to transfer"); return; }
    busy.current = true;
    try {
      let to = tables.find((t) => t.code.toLowerCase() === toRaw.toLowerCase() && (t.outlet || "BAR") === outlet);
      if (!to) to = await api.post<Table>("/api/tables", { code: toRaw, name: `Table ${toRaw}`, outlet });
      const result = await api.post<{ sourceClosed: boolean }>("/api/tables/item-transfer", {
        fromTableId: from.id,
        toTableId: to.id,
        itemIds,
        reason: reason.trim() || undefined,
      });
      onDone(from.code, to, !!result.sourceClosed);
    } catch (e) {
      busy.current = false;
      onMessage(e instanceof Error ? e.message : "Item transfer failed");
    }
  }

  return (
    <div className="item-xfer-dlg">
      <div className="item-xfer-head">
        <div className="item-xfer-form">
          <div className="xfer-row">
            <span>Current Table No :</span>
            <input
              ref={fromRef}
              className="win green"
              list="item-xfer-from"
              value={fromCode}
              onChange={(e) => { setFromCode(e.target.value); void loadItems(e.target.value); }}
              onKeyDown={onEnter(() => { if (acceptCurrent()) toRef.current?.focus(); })}
            />
            <datalist id="item-xfer-from">
              {occupied.map((t) => <option key={t.id} value={t.code} />)}
            </datalist>
            <span>New Table No :</span>
            <input
              ref={toRef}
              className="win"
              list="item-xfer-to"
              value={toCode}
              onChange={(e) => setToCode(e.target.value)}
              onKeyDown={onEnter(() => reasonRef.current?.focus())}
            />
            <datalist id="item-xfer-to">
              {tables.filter((t) => (t.outlet || "BAR") === outlet).map((t) => <option key={t.id} value={t.code} />)}
            </datalist>
          </div>
          <div className="xfer-row">
            <span>Reason :</span>
            <input
              ref={reasonRef}
              className="win xfer-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={onEnter(() => { setTimeout(() => xferRef.current?.focus(), 0); })}
            />
          </div>
        </div>
        <div className="xfer-btns">
          <button ref={xferRef} type="button" className="fn" onClick={() => void transfer()}>Transfer</button>
          <button type="button" className="fn" onClick={onClose}>Cancel</button>
        </div>
      </div>
      <div className="item-xfer-grid">
        <table>
          <thead>
            <tr>
              <th>KOT</th>
              <th>Item Code</th>
              <th>Item Name</th>
              <th>Qty</th>
              <th>Price</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.id}
                className={i === sel ? "sel" : ""}
                onClick={() => { setSel(i); toggle(r.id); }}
              >
                <td className="kot">{String(r.kot_number).replace(/\D/g, "")}</td>
                <td>{r.sku}</td>
                <td>{r.name}</td>
                <td>{Number(r.qty).toFixed(2)}</td>
                <td>{rupee(r.unit_price)}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={!!checked[r.id]}
                    onChange={() => toggle(r.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
