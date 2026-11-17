import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "./api";
import { formatINR, parseRupeesInput } from "../shared/money";
import { itemMatchScore } from "../shared/itemSearch";
import type { PaymentMode } from "../shared/types";

type Table = { id: string; code: string; status: string; customer_name?: string; running_total?: number; outlet?: string };
type BillProduct = { id: string; name: string; sku: string; base_price?: number };
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

function numText(value: string) {
  const clean = value.replace(/[^\d.]/g, "");
  const dot = clean.indexOf(".");
  if (dot < 0) return clean;
  return clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, "");
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
  catalog,
  onClose,
  onPrinted,
  onChanged,
  onReopen,
  onMessage,
}: {
  orderId: string;
  table: Table;
  outlet: string;
  waiter: string;
  guest: string;
  mobile: string;
  catalog: BillProduct[];
  onClose: () => void;
  onPrinted: (invoice: any) => void;
  onChanged?: () => void;
  onReopen?: () => void;
  onMessage: (m: string) => void;
}) {
  const [bill, setBill] = useState<any>(null);
  const [discPct, setDiscPct] = useState("0.00");
  const [discAmt, setDiscAmt] = useState("0.00");
  const [noDisc, setNoDisc] = useState<string[]>([]);
  const discMode = useRef<"pct" | "amt">("pct");
  const wantPct = useRef(0);
  const wantAmt = useRef(0);
  const [svcPct, setSvcPct] = useState("10");
  const [delivery, setDelivery] = useState("0");
  const [name, setName] = useState(guest);
  const [mob, setMob] = useState(mobile);
  const [pax, setPax] = useState("1");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [remark, setRemark] = useState("");
  const [comp, setComp] = useState(false);
  const [rowSel, setRowSel] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const discRef = useRef<HTMLInputElement>(null);
  const printRef = useRef<HTMLButtonElement>(null);
  const addNameRef = useRef<HTMLInputElement>(null);
  const addQtyRef = useRef<HTMLInputElement>(null);
  const editNameRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const skipQtyBlur = useRef(false);
  const skipPriceBlur = useRef(false);
  const pendingFocus = useRef<number | null>(null);
  const itemsRef = useRef<any[]>([]);
  const rowSelRef = useRef(0);
  const [editQty, setEditQty] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [nameLocked, setNameLocked] = useState(true);
  const [namePick, setNamePick] = useState(0);
  const [nameOpen, setNameOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addPick, setAddPick] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [addQty, setAddQty] = useState("1");
  const [pending, setPending] = useState<BillProduct | null>(null);
  const [dropBox, setDropBox] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);

  function discountBody(next?: { discountPct?: number; discountAmt?: number; mode?: "pct" | "amt"; excludeItemIds?: string[] }) {
    const mode = next?.mode ?? discMode.current;
    const excludeItemIds = next?.excludeItemIds ?? noDisc;
    if (mode === "amt") {
      return {
        discount: Math.round((Number(next?.discountAmt ?? wantAmt.current) || 0) * 100),
        discountFrom: "amount" as const,
        excludeItemIds,
      };
    }
    return {
      discountPct: next?.discountPct ?? wantPct.current,
      discountFrom: "percent" as const,
      excludeItemIds,
    };
  }

  async function load(next?: { discountPct?: number; discountAmt?: number; mode?: "pct" | "amt"; serviceChargePct?: number; otherCharges?: number; excludeItemIds?: string[] }) {
    const mode = next?.mode ?? discMode.current;
    let preview: any;
    try {
      preview = await api.post<any>("/api/invoices/preview", {
        orderId,
        ...discountBody(next),
        serviceChargePct: next?.serviceChargePct ?? (Number(svcPct) || 0),
        otherCharges: Math.round((Number(next?.otherCharges ?? delivery) || 0) * 100),
      });
    } catch (e) {
      if (e instanceof Error && /no items/i.test(e.message)) {
        setBill((prev: any) => prev ? { ...prev, items: [], totalQty: 0, foodTotal: 0, drinksTotal: 0, tax: 0, serviceCharge: 0, discount: 0, grandTotal: 0, roundOff: 0 } : prev);
        return null;
      }
      throw e;
    }
    setBill(preview);
    if (mode === "amt") setDiscPct(Number(preview.discountPct ?? 0).toFixed(2));
    setDiscAmt(rupee(preview.discount ?? 0));
    if (next?.serviceChargePct == null && preview.serviceChargePct != null && discPct === "0.00" && !bill) {
      setSvcPct(String(preview.serviceChargePct));
    }
    return preview;
  }

  useEffect(() => {
    let cancel = false;
    (async () => {
      let next: { discountAmt?: number; mode?: "amt"; serviceChargePct?: number; otherCharges?: number } | undefined;
      try {
        const snap = await api.get<any>(`/api/tables/${table.id}/invoice`);
        const inv = snap?.invoice;
        if (inv && !cancel) {
          const discountAmt = Number(inv.discount ?? 0) / 100;
          const serviceChargePct = Number(inv.service_charge_pct ?? 0);
          const otherCharges = Number(inv.other_charges ?? 0) / 100;
          discMode.current = "amt";
          wantAmt.current = discountAmt;
          setDiscAmt(discountAmt.toFixed(2));
          setSvcPct(String(serviceChargePct));
          setDelivery(String(otherCharges));
          next = { mode: "amt", discountAmt, serviceChargePct, otherCharges };
        }
      } catch { /* bill not printed yet */ }
      if (cancel) return;
      try {
        await load(next);
        setTimeout(() => { discRef.current?.focus(); discRef.current?.select(); }, 0);
      } catch (e) {
        onMessage(e instanceof Error ? e.message : "Could not open bill");
      }
    })();
    return () => { cancel = true; };
  }, [orderId]);

  function scrollBillRow(index: number) {
    const grid = gridRef.current;
    const row = grid?.querySelectorAll("tbody tr")[index] as HTMLElement | undefined;
    if (!grid || !row) return;
    const headerH = grid.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const viewTop = grid.getBoundingClientRect().top + headerH;
    const viewBot = grid.getBoundingClientRect().bottom;
    const rowTop = row.getBoundingClientRect().top;
    const rowBot = row.getBoundingClientRect().bottom;
    if (rowTop < viewTop) grid.scrollTop -= viewTop - rowTop;
    else if (rowBot > viewBot) grid.scrollTop += rowBot - viewBot;
  }

  function ranked(query: string) {
    const v = query.trim();
    if (!v) return [];
    return catalog
      .map((p) => ({ p, score: itemMatchScore(p.name, p.sku, v) }))
      .filter((row): row is { p: BillProduct; score: number } => row.score != null)
      .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name))
      .map((row) => row.p);
  }

  const nameMatches = useMemo(() => (nameOpen && !nameLocked ? ranked(nameQuery) : []), [catalog, nameQuery, nameOpen, nameLocked]);
  const addMatches = useMemo(() => (addOpen && !pending ? ranked(addQuery) : []), [catalog, addQuery, addOpen, pending]);
  const listOpen = nameOpen || addOpen;
  const listMatches = nameOpen ? nameMatches : addMatches;
  const listPick = nameOpen ? namePick : addPick;

  useEffect(() => {
    if (addPick >= addMatches.length) setAddPick(addMatches.length ? addMatches.length - 1 : 0);
  }, [addMatches.length, addPick]);

  useEffect(() => {
    if (namePick >= nameMatches.length) setNamePick(nameMatches.length ? nameMatches.length - 1 : 0);
  }, [nameMatches.length, namePick]);

  itemsRef.current = bill?.items ?? [];
  rowSelRef.current = rowSel;

  const shown = useMemo(() => {
    const source = (bill?.items ?? []) as any[];
    const items = source.map((it, i) => {
      if (i !== rowSel) return it;
      const raw = editQty.trim();
      const qty = raw === "" ? 0 : Number(raw);
      const priceRaw = editPrice.trim();
      const unit = priceRaw === "" ? 0 : Math.round(Number(priceRaw) * 100);
      if (!Number.isFinite(qty) || !Number.isFinite(unit)) return it;
      const amount = Math.round(qty * unit);
      const tax = Math.round(amount * (Number(it.tax_rate) / 100));
      return { ...it, qty, amount, tax };
    });
    const extra = pending ? Math.round((Number(addQty) || 0) * Number(pending.base_price || 0)) : 0;
    const foodTotal = items.filter((it) => it.station === "KITCHEN").reduce((s, it) => s + Number(it.amount), 0);
    const drinksTotal = items.filter((it) => it.station !== "KITCHEN").reduce((s, it) => s + Number(it.amount), 0) + extra;
    const subtotal = foodTotal + drinksTotal;
    const tax = items.reduce((s, it) => s + Number(it.tax), 0);
    const excluded = new Set(noDisc);
    const discountable = items
      .filter((it) => !(it.ids ?? [it.id]).some((id: string) => excluded.has(id)))
      .reduce((s, it) => s + Number(it.amount), 0) + extra;
    const svcMode = bill?.serviceChargeMode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE";
    const pct = Number(svcPct) || 0;
    const discount = discMode.current === "amt"
      ? Math.max(0, Math.min(Math.round((Number(discAmt) || 0) * 100), discountable))
      : Math.min(discountable, Math.round((discountable * (Number(discPct) || 0)) / 100));
    const other = Math.round((Number(delivery) || 0) * 100);
    const after = Math.max(0, subtotal - discount);
    const service = svcMode === "INCLUSIVE"
      ? Math.round(after - after / (1 + pct / 100))
      : Math.round((after * pct) / 100);
    const unrounded = svcMode === "INCLUSIVE" ? after + tax + other : after + service + tax + other;
    const grand = Math.round(unrounded / 100) * 100;
    return {
      items,
      totalQty: items.reduce((s, it) => s + Number(it.qty), 0) + (pending ? Number(addQty) || 0 : 0),
      subtotal,
      tax,
      discountable,
      discount,
      service,
      roundOff: grand - unrounded,
      grand,
      extra,
    };
  }, [bill, rowSel, editQty, editPrice, addQty, pending, noDisc, svcPct, discPct, discAmt, delivery]);

  useEffect(() => {
    const it = bill?.items?.[rowSel];
    setEditQty(it ? String(Math.round(Number(it.qty))) : "");
    setEditPrice(it ? rupee(Number(it.unit_price)) : "");
    setNameQuery(it?.name ?? "");
    setNameLocked(true);
    setNameOpen(false);
  }, [bill, rowSel]);

  useEffect(() => {
    const index = pendingFocus.current;
    if (index == null || index !== rowSel) return;
    const it = bill?.items?.[rowSel];
    if (it && nameQuery !== it.name) return;
    pendingFocus.current = null;
    scrollBillRow(rowSel);
    const name = gridRef.current?.querySelector<HTMLInputElement>("tr.on input.name");
    name?.focus();
    name?.select();
  }, [rowSel, nameQuery, bill]);

  function focusLine(index: number) {
    const count = itemsRef.current.length;
    if (index < 0 || index >= count) {
      pendingFocus.current = null;
      setRowSel(-1);
      requestAnimationFrame(() => {
        scrollBillRow(count);
        addNameRef.current?.focus();
      });
      return;
    }
    pendingFocus.current = index;
    if (index === rowSelRef.current) {
      pendingFocus.current = null;
      scrollBillRow(index);
      const name = gridRef.current?.querySelector<HTMLInputElement>("tr.on input.name");
      name?.focus();
      name?.select();
      return;
    }
    setRowSel(index);
  }

  useLayoutEffect(() => {
    const input = nameOpen ? editNameRef.current : addOpen ? addNameRef.current : null;
    if (!input) { setDropBox(null); return; }
    const r = input.getBoundingClientRect();
    const width = Math.min(460, Math.max(r.width, 340));
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const up = spaceBelow < 160 && r.top > spaceBelow;
    setDropBox({ top: up ? r.top : r.bottom, left, width, up });
  }, [nameOpen, addOpen, nameQuery, addQuery, nameMatches.length, addMatches.length]);

  useLayoutEffect(() => {
    const on = document.querySelector(".bill-drop > div.on") as HTMLElement | null;
    const box = on?.parentElement;
    if (!on || !box) return;
    const top = on.offsetTop;
    const bottom = top + on.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }, [listPick, listOpen, listMatches.length]);

  function moveBillRow(dir: number) {
    const count = bill?.items?.length ?? 0;
    if (!count) {
      addNameRef.current?.focus();
      return;
    }
    const next = Math.max(0, Math.min(count - 1, rowSel + dir));
    if (dir > 0 && rowSel >= count - 1) {
      addNameRef.current?.focus();
      return;
    }
    setRowSel(next);
    requestAnimationFrame(() => scrollBillRow(next));
  }

  function chooseAdd(p: BillProduct) {
    setPending(p);
    setAddQuery(p.name);
    setAddOpen(false);
    setAddQty("1");
    requestAnimationFrame(() => { addQtyRef.current?.focus(); addQtyRef.current?.select(); });
  }

  async function chooseName(it: any, p: BillProduct) {
    setNameOpen(false);
    setNameLocked(true);
    setNameQuery(p.name);
    const focusQty = () => editNameRef.current?.closest("tr")?.querySelector<HTMLInputElement>("input.qty")?.focus();
    if (!it || p.id === it.product_id) {
      requestAnimationFrame(focusQty);
      return;
    }
    if (busy.current) return;
    busy.current = true;
    try {
      await api.post(`/api/orders/${orderId}/bill-item`, { ids: it.ids ?? [it.id], productId: p.id, outlet });
      await load();
      onChanged?.();
      requestAnimationFrame(focusQty);
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not change item");
      setNameQuery(it.name ?? "");
    } finally {
      busy.current = false;
    }
  }

  async function commitQty(it: any, raw: string) {
    if (!it || raw.trim() === "") return;
    const qty = Number(raw);
    if (!Number.isInteger(qty) || qty < 0) return;
    if (qty === Math.round(Number(it.qty))) return;
    if (busy.current) return;
    busy.current = true;
    try {
      await api.post(`/api/orders/${orderId}/bill-qty`, { ids: it.ids ?? [it.id], qty });
      await load();
      onChanged?.();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not change qty");
    } finally {
      busy.current = false;
    }
  }

  async function commitPrice(it: any, raw: string) {
    if (!it || raw.trim() === "") return;
    let price = 0;
    try {
      price = parseRupeesInput(raw);
    } catch {
      onMessage("Enter a price");
      return;
    }
    if (price === Number(it.unit_price)) return;
    if (busy.current) return;
    busy.current = true;
    try {
      await api.post(`/api/orders/${orderId}/bill-price`, { ids: it.ids ?? [it.id], price });
      await load();
      onChanged?.();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not change price");
    } finally {
      busy.current = false;
    }
  }

  async function addLine() {
    if (!pending) {
      onMessage("Select an item");
      addNameRef.current?.focus();
      return;
    }
    const qty = Number(addQty);
    if (!Number.isInteger(qty) || qty === 0) {
      onMessage("Enter qty");
      addQtyRef.current?.focus();
      return;
    }
    if (busy.current) return;
    busy.current = true;
    try {
      await api.post(`/api/orders/${orderId}/items`, { productId: pending.id, qty, outlet });
      setPending(null);
      setAddQuery("");
      setAddOpen(false);
      setAddQty("1");
      await load();
      onChanged?.();
      requestAnimationFrame(() => addNameRef.current?.focus());
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not add item");
    } finally {
      busy.current = false;
    }
  }

  function removeSelected() {
    const it = bill?.items?.[rowSel];
    if (!it) return;
    void commitQty(it, "0");
  }

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (addOpen || nameOpen) {
          e.preventDefault();
          e.stopPropagation();
          setAddOpen(false);
          setNameOpen(false);
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
      if (e.key === "F10") { e.preventDefault(); e.stopPropagation(); void printBill(); }
      if (e.key === "F5") { e.preventDefault(); e.stopPropagation(); void printBill(false); }
      if (e.key === "F4") {
        const typing = document.activeElement === addNameRef.current || document.activeElement === addQtyRef.current || document.activeElement === editNameRef.current || (document.activeElement as HTMLElement | null)?.classList.contains("price");
        if (!typing) {
          e.preventDefault();
          e.stopPropagation();
          removeSelected();
        }
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement === gridRef.current) {
        e.preventDefault();
        e.stopPropagation();
        moveBillRow(e.key === "ArrowDown" ? 1 : -1);
      }
      if (e.key === "Enter" && document.activeElement === gridRef.current) {
        e.preventDefault();
        e.stopPropagation();
        const name = gridRef.current?.querySelector<HTMLInputElement>("tr.on input.name");
        name?.focus();
        name?.select();
      }
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
        ...discountBody(),
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
        <table className="bill-form">
          <colgroup>
            <col className="c-lbl" /><col /><col className="c-lbl" /><col /><col className="c-lbl" /><col className="c-pax" />
          </colgroup>
          <tbody>
            <tr>
              <td className="lbl">Table No. :</td>
              <td>
                <select className="win" value={table.code} onChange={() => undefined}>
                  <option>{table.code}</option>
                </select>
              </td>
              <td className="lbl">Name :</td>
              <td>
                <div className="name-cell">
                  <label className="chk"><input type="checkbox" /> A/C</label>
                  <input className="win" value={name} onChange={(e) => setName(e.target.value)} />
                  <button type="button" className="fn bh-plus">+</button>
                </div>
              </td>
              <td className="lbl">Pax :</td>
              <td><input className="win" data-num="int" value={pax} onChange={(e) => setPax(e.target.value.replace(/\D/g, ""))} /></td>
            </tr>
            <tr>
              <td className="lbl">Bill No. :</td>
              <td><input className="win" value={bill?.invoiceNumber ?? ""} readOnly /></td>
              <td className="lbl">Mobile No. :</td>
              <td colSpan={3}><input className="win" data-num="int" value={mob} onChange={(e) => setMob(e.target.value.replace(/\D/g, ""))} /></td>
            </tr>
            <tr>
              <td className="lbl">Date :</td>
              <td>
                <div className="date-cell">
                  <input className="win" value={dateStr} readOnly />
                  <input className="win" value={timeStr} readOnly />
                </div>
              </td>
              <td className="lbl">GSTIN :</td>
              <td colSpan={3}><input className="win" value={gstin} onChange={(e) => setGstin(e.target.value)} /></td>
            </tr>
            <tr>
              <td colSpan={2}>
                <label className="chk"><input type="checkbox" checked={comp} onChange={(e) => setComp(e.target.checked)} /> I want make this complimentary</label>
              </td>
              <td className="lbl">Address :</td>
              <td colSpan={3}><input className="win" value={address} onChange={(e) => setAddress(e.target.value)} /></td>
            </tr>
            <tr>
              <td className="lbl">Steward :</td>
              <td><input className="win" value={waiter} readOnly /></td>
              <td /><td /><td /><td />
            </tr>
          </tbody>
        </table>

        <div
          className="bill-grid-wrap"
          ref={gridRef}
          tabIndex={-1}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("input")) return;
            gridRef.current?.focus();
          }}
        >
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
                <tr key={it.id} className={i === rowSel ? "on" : ""} onClick={() => {
                  if (i === (bill?.items?.length ?? 0) - 1) focusLine(i + 1);
                  else setRowSel(i);
                }}>
                  <td>{String(i + 1).padStart(2, "0")}</td>
                  <td>
                    {i === rowSel ? (
                      <input
                        ref={editNameRef}
                        className="line name"
                        autoComplete="off"
                        spellCheck={false}
                        data-list={nameOpen ? "open" : undefined}
                        value={nameQuery}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const v = e.target.value;
                          setNameLocked(false);
                          setNameQuery(v);
                          setNamePick(0);
                          setNameOpen(v.trim().length > 0);
                          setAddOpen(false);
                        }}
                        onBlur={() => {
                          setNameOpen(false);
                          if (!nameLocked) {
                            setNameQuery(it.name ?? "");
                            setNameLocked(true);
                          }
                        }}
                        onKeyDown={(e) => {
                          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && nameOpen) {
                            e.preventDefault();
                            e.stopPropagation();
                            setNamePick((n) => {
                              const max = nameMatches.length - 1;
                              if (max < 0) return 0;
                              return e.key === "ArrowDown" ? Math.min(max, n + 1) : Math.max(0, n - 1);
                            });
                          } else if (e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                            const chosen = !nameLocked ? (nameMatches[namePick] ?? nameMatches[0]) : null;
                            if (chosen) void chooseName(it, chosen);
                            else e.currentTarget.closest("tr")?.querySelector<HTMLInputElement>("input.qty")?.focus();
                          }
                        }}
                      />
                    ) : it.name}
                  </td>
                  <td>
                    {i === rowSel ? (
                      <input
                        className="line qty"
                        data-num="int"
                        value={editQty}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditQty(e.target.value.replace(/\D/g, ""))}
                        onBlur={() => {
                          if (skipQtyBlur.current) { skipQtyBlur.current = false; return; }
                          void commitQty(it, editQty);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          e.stopPropagation();
                          skipQtyBlur.current = true;
                          const raw = (e.target as HTMLInputElement).value;
                          const row = e.currentTarget.closest("tr");
                          void commitQty(it, raw).then(() => {
                            const price = row?.querySelector<HTMLInputElement>("input.price");
                            price?.focus();
                            price?.select();
                          });
                        }}
                      />
                    ) : Number(it.qty).toFixed(2)}
                  </td>
                  <td>
                    {i === rowSel ? (
                      <input
                        className="line price"
                        data-num="dec"
                        value={editPrice}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditPrice(numText(e.target.value))}
                        onBlur={() => {
                          if (skipPriceBlur.current) { skipPriceBlur.current = false; return; }
                          void commitPrice(it, editPrice);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          e.stopPropagation();
                          skipPriceBlur.current = true;
                          const raw = (e.target as HTMLInputElement).value;
                          const next = i + 1;
                          void commitPrice(it, raw).then(() => focusLine(next));
                        }}
                      />
                    ) : rupee(shown.items[i]?.unit_price ?? it.unit_price)}
                  </td>
                  <td>{Number(it.tax_rate).toFixed(2)}</td>
                  <td>{rupee(shown.items[i]?.amount ?? it.amount)}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={(it.ids ?? [it.id]).every((id: string) => noDisc.includes(id))}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const ids: string[] = it.ids ?? [it.id];
                        const excludeItemIds = e.target.checked
                          ? [...new Set([...noDisc, ...ids])]
                          : noDisc.filter((id) => !ids.includes(id));
                        setNoDisc(excludeItemIds);
                        void load({ excludeItemIds });
                      }}
                    />
                  </td>
                </tr>
              ))}
              <tr className="add">
                <td>{String((bill?.items?.length ?? 0) + 1).padStart(2, "0")}</td>
                <td>
                  <input
                    ref={addNameRef}
                    className="line"
                    autoComplete="off"
                    spellCheck={false}
                    data-list={addOpen ? "open" : undefined}
                    value={addQuery}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPending(null);
                      setAddQuery(v);
                      setAddPick(0);
                      setAddOpen(v.trim().length > 0);
                    }}
                    onKeyDown={(e) => {
                      if (pending && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                        e.preventDefault();
                        setPending(null);
                        setAddQuery(e.key);
                        setAddPick(0);
                        setAddOpen(true);
                        return;
                      }
                      if (e.key === "Backspace" && pending) {
                        e.preventDefault();
                        setPending(null);
                        setAddOpen(false);
                        return;
                      }
                      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && addOpen) {
                        e.preventDefault();
                        e.stopPropagation();
                        setAddPick((n) => {
                          const max = addMatches.length - 1;
                          if (max < 0) return 0;
                          return e.key === "ArrowDown" ? Math.min(max, n + 1) : Math.max(0, n - 1);
                        });
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        const chosen = addMatches[addPick] ?? addMatches[0];
                        if (chosen) chooseAdd(chosen);
                        else if (pending) addQtyRef.current?.focus();
                      }
                    }}
                  />
                </td>
                <td>
                  <input
                    ref={addQtyRef}
                    className="line"
                    data-num="int"
                    value={addQty}
                    onChange={(e) => setAddQty(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      e.stopPropagation();
                      void addLine();
                    }}
                  />
                </td>
                <td>{pending ? rupee(Number(pending.base_price || 0)) : ""}</td>
                <td />
                <td>{pending ? rupee(shown.extra) : ""}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        {listOpen && dropBox && listMatches.length > 0 && createPortal(
          <div
            className={`bill-drop${dropBox.up ? " up" : ""}`}
            style={{ top: dropBox.top, left: dropBox.left, width: dropBox.width }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {listMatches.map((p, i) => (
              <div
                key={p.id}
                className={i === listPick ? "on" : ""}
                onMouseEnter={() => (nameOpen ? setNamePick(i) : setAddPick(i))}
                onClick={() => {
                  if (nameOpen) {
                    const it = bill?.items?.[rowSel];
                    if (it) void chooseName(it, p);
                  } else chooseAdd(p);
                }}
              >
                {p.name}
              </div>
            ))}
          </div>,
          document.body,
        )}

        <table className="bill-totals">
          <tbody>
            <tr>
              <td>
                <table className="bill-side">
                  <tbody>
                    <tr><td className="lbl">Total Qty :</td><td><input className="win" readOnly value={shown.totalQty} /></td></tr>
                    <tr><td className="lbl">Adv. Booking No. :</td><td><input className="win" /></td></tr>
                    <tr><td className="lbl">Promocode Visit ID :</td><td><input className="win" /></td></tr>
                    <tr><td className="lbl">Point Redeem :</td><td><input className="win" data-num="dec" defaultValue="0.00" /></td></tr>
                    <tr><td className="lbl">Verify By :</td><td><input className="win" /></td></tr>
                    <tr><td className="lbl">Offer By :</td><td><input className="win" /></td></tr>
                    <tr><td className="lbl">Remark :</td><td><input className="win" value={remark} onChange={(e) => setRemark(e.target.value)} /></td></tr>
                  </tbody>
                </table>
              </td>
              <td>
                <table className="bill-side">
                  <tbody>
                    <tr><td className="lbl">Total Amount :</td><td><input className="win" readOnly value={rupee(shown.subtotal)} /></td></tr>
                    <tr>
                      <td className="lbl">Discount (%) :</td>
                      <td>
                        <div className="svc">
                          <input
                            ref={discRef}
                            className="win pct green"
                            data-num="dec"
                            value={discMode.current === "amt" ? (shown.discountable ? ((shown.discount / shown.discountable) * 100).toFixed(2) : "0.00") : discPct}
                            onChange={(e) => { const v = numText(e.target.value); discMode.current = "pct"; wantPct.current = Number(v) || 0; setDiscPct(v); }}
                            onBlur={(e) => { discMode.current = "pct"; wantPct.current = Number(e.target.value) || 0; void load({ mode: "pct", discountPct: wantPct.current }); }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                discMode.current = "pct";
                                wantPct.current = Number((e.target as HTMLInputElement).value) || 0;
                                void load({ mode: "pct", discountPct: wantPct.current }).then(() => printRef.current?.focus());
                              }
                            }}
                          />
                          <span>%</span>
                          <input
                            className="win amt"
                            data-num="dec"
                            value={discMode.current === "amt" ? discAmt : rupee(shown.discount)}
                            onChange={(e) => { const v = numText(e.target.value); discMode.current = "amt"; wantAmt.current = Number(v) || 0; setDiscAmt(v); }}
                            onBlur={(e) => { discMode.current = "amt"; wantAmt.current = Number(e.target.value) || 0; void load({ mode: "amt", discountAmt: wantAmt.current }); }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                discMode.current = "amt";
                                wantAmt.current = Number((e.target as HTMLInputElement).value) || 0;
                                void load({ mode: "amt", discountAmt: wantAmt.current }).then(() => printRef.current?.focus());
                              }
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td className="lbl">Service Charges :</td>
                      <td>
                        <div className="svc">
                          <input
                            className="win pct"
                            data-num="dec"
                            value={svcPct}
                            onChange={(e) => setSvcPct(numText(e.target.value))}
                            onBlur={(e) => void load({ serviceChargePct: Number(e.target.value) || 0 })}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
                              const serviceChargePct = Number((e.target as HTMLInputElement).value) || 0;
                              void load({ serviceChargePct }).then(() => printRef.current?.focus());
                            }}
                          />
                          <span>%</span>
                          <input className="win amt" readOnly value={rupee(shown.service)} />
                        </div>
                      </td>
                    </tr>
                    <tr><td className="lbl">Tax Amount :</td><td><input className="win" readOnly value={rupee(shown.tax)} /></td></tr>
                    <tr><td className="lbl">Delivery Charge :</td><td><input className="win" data-num="dec" value={delivery} onChange={(e) => setDelivery(numText(e.target.value))} onBlur={() => void load()} /></td></tr>
                    <tr><td className="lbl">Round Off :</td><td><input className="win" readOnly value={rupee(shown.roundOff)} /></td></tr>
                    <tr><td className="lbl">Net Amount :</td><td><input className="win" readOnly value={Math.round(shown.grand / 100)} /></td></tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>

        <div className="bill-btns">
          <button ref={printRef} type="button" className="fn" onClick={() => void printBill(true)} onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void printBill(true); }
          }}>Print Bill (F10)</button>
          <button type="button" className="fn" onClick={() => onReopen?.()}>Reopen Bill</button>
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
              onChange={(e) => setMethod(e.target.value as PaymentMode)}
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
              data-num="dec"
              value={amount}
              onChange={(e) => setAmount(numText(e.target.value))}
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
          <div className="st-row"><span>Balance Amount :</span><input className="win" readOnly value={rupee(Math.max(0, due - Math.round((Number(amount) || 0) * 100)))} /></div>
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

export function AlertBox({ message, onClose }: { message: string; onClose: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    okRef.current?.focus();
    function keys(e: KeyboardEvent) {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, []);
  return (
    <div className="dialog alert-dlg">
      <div className="dialog-cap">
        <span className="cap-dot" />
        THE BOSS
        <span className="cap-btns"><button type="button" onClick={onClose}>✕</button></span>
      </div>
      <div className="dialog-body">
        <p>{message}</p>
        <div className="bill-btns">
          <button ref={okRef} type="button" className="fn" onClick={onClose}>OK</button>
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
