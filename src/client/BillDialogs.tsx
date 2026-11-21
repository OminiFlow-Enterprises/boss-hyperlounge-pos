import { formatUiLabel } from "./formatUiLabel";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ignoreRepeatedPrintKey, printBill } from "./printActions";
import { createPortal } from "react-dom";
import { api, ApiError } from "./api";
import { billLineTaxes, parseRupeesInput } from "../shared/money";
import { billApprovalFields } from "../shared/billApproval";
import { formatTableNo } from "../shared/tableLabel";
import { itemMatchScore } from "../shared/itemSearch";
import type { BillDetails, BillLineEdit, PaymentMode } from "../shared/types";
import { cardNoDigits, cardNoReady, stayOnCard } from "./formNav";
import { ComplimentaryMasterDialog, type CompAccount } from "./ComplimentaryMaster";

type Table = { id: string; code: string; status: string; customer_name?: string; card_number?: string; running_total?: number; outlet?: string };

function shownTableNo(table: { code: string; card_number?: string | null; outlet?: string | null }, outlet?: string) {
  return formatTableNo(table.code, table.card_number, table.outlet || outlet);
}
type BillProduct = { id: string; name: string; sku: string; base_price?: number };
type TodayCard = { id: string; card_number: string; customer_name: string; usable: number; available?: number; recharged: number };

const PAY_MODES: Array<{ id: PaymentMode; label: string }> = [
  { id: "CASH", label: "Cash" },
  { id: "CARD", label: "Bank Transfer" },
  { id: "MEMBER_CARD", label: "Prepaid Card" },
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

/** Win32 caption ✕ — mousedown so overlays / focus traps cannot swallow the click. */
export function CapClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="cap-x"
      tabIndex={-1}
      aria-label="Close"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      ✕
    </button>
  );
}

export function CapBtns({ onClose, chrome = true }: { onClose: () => void; chrome?: boolean }) {
  return (
    <span className="cap-btns">
      {chrome && (
        <>
          <button type="button" tabIndex={-1} aria-hidden="true">–</button>
          <button type="button" tabIndex={-1} aria-hidden="true">□</button>
        </>
      )}
      <CapClose onClose={onClose} />
    </span>
  );
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
      <div className="prep-pick-cap">
        {title}
        <CapClose onClose={onClose} />
      </div>
      {tables.map((t, i) => (
        <div
          key={t.id}
          className={`prep-pick-row ${i === pick ? "on" : ""}`}
          onMouseEnter={() => setPick(i)}
          onClick={() => onPick(t)}
        >
          {shownTableNo(t)}
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
  onSettle,
  onChanged,
  existingInvoiceId,
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
  /** Save (F5) + Yes opens settlement. Does not ask to print. */
  onSettle: (invoice: any) => void;
  onChanged?: () => void;
  existingInvoiceId?: string;
  onMessage: (m: string, after?: () => void) => void;
}) {
  const [bill, setBill] = useState<any>(null);
  const [discPct, setDiscPct] = useState("0.00");
  const [discAmt, setDiscAmt] = useState("0.00");
  const [noDisc, setNoDisc] = useState<string[]>([]);
  const discMode = useRef<"pct" | "amt">("pct");
  const wantPct = useRef(0);
  const wantAmt = useRef(0);
  const DEFAULT_SVC_PCT = 10;
  const [svcPct, setSvcPct] = useState(String(DEFAULT_SVC_PCT));
  const svcPctDraft = useRef(String(DEFAULT_SVC_PCT));
  const previewRequest = useRef(0);
  function svcPctValue(raw?: string | number | null) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SVC_PCT;
  }
  const [delivery, setDelivery] = useState("0");
  const [name, setName] = useState(guest);
  const [mob, setMob] = useState(mobile);
  const [pax, setPax] = useState("1");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [remark, setRemark] = useState("");
  const [remarkRequired, setRemarkRequired] = useState(false);
  const nc = outlet === "NC";
  const [comp, setComp] = useState(nc);
  const isComplimentary = nc || comp;
  const [accounts, setAccounts] = useState<CompAccount[]>([]);
  const [compId, setCompId] = useState("");
  const [compRequired, setCompRequired] = useState(false);
  const [masterOpen, setMasterOpen] = useState(false);
  const compRef = useRef<HTMLSelectElement>(null);
  const remarkRef = useRef<HTMLInputElement>(null);
  const [rowSel, setRowSel] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const discRef = useRef<HTMLInputElement>(null);
  const printRef = useRef<HTMLButtonElement>(null);
  const printedWithEnter = useRef(false);
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
  const [invalidAddField, setInvalidAddField] = useState<"item" | "qty" | null>(null);
  const [pending, setPending] = useState<BillProduct | null>(null);
  const [dropBox, setDropBox] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const [ask, setAsk] = useState<"save" | "print" | null>(null);
  const [printChoice, setPrintChoice] = useState<{ id: string } | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [masterPin, setMasterPin] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const masterPinRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const invoiceId = useRef<string | undefined>(undefined);
  const serviceChargeMode = useRef<"INCLUSIVE" | "EXCLUSIVE">();
  const edits = useRef<BillLineEdit[]>([]);
  const editPreview = useRef<Promise<boolean>>();
  const savedApprovalFields = useRef("");
  const savedRemark = useRef("");

  function billFields() {
    return {
      billDetails: {
        mobile: mob,
        pax,
        address,
        remark: remark.trim() || savedRemark.current,
        excludeItemIds: noDisc,
        discountPct: discMode.current === "pct" ? wantPct.current : undefined,
      } satisfies BillDetails,
      ...discountBody(),
      otherCharges: isComplimentary ? 0 : Math.round((Number(delivery) || 0) * 100),
      complimentaryAccountId: isComplimentary ? compId : undefined,
      customerDisplayName: name.trim(),
      customerGstin: gstin.trim(),
    };
  }

  function needsApproval() {
    return edits.current.length > 0 || billApprovalFields(billFields()) !== savedApprovalFields.current;
  }

  function highlightRemark() {
    closeApproval();
    setRemarkRequired(true);
    remarkRef.current?.focus();
  }

  function validateBillFields() {
    if (isComplimentary && !compId) {
      closeApproval();
      setCompRequired(true);
      compRef.current?.focus();
      return false;
    }
    if (needsApproval() && !remark.trim()) {
      highlightRemark();
      return false;
    }
    return true;
  }
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

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
    const request = ++previewRequest.current;
    const mode = next?.mode ?? discMode.current;
    let preview: any;
    try {
      preview = await api.post<any>("/api/invoices/preview", {
        orderId,
        invoiceId: invoiceId.current,
        edits: edits.current,
        serviceChargeMode: serviceChargeMode.current,
        ...discountBody(next),
        serviceChargePct: next?.serviceChargePct ?? svcPctValue(svcPctDraft.current),
        otherCharges: Math.round((Number(next?.otherCharges ?? delivery) || 0) * 100),
      });
    } catch (e) {
      if (e instanceof Error && /no items/i.test(e.message)) {
        if (request === previewRequest.current) {
          setBill((prev: any) => prev ? { ...prev, items: [], totalQty: 0, foodTotal: 0, drinksTotal: 0, tax: 0, serviceCharge: 0, discount: 0, grandTotal: 0, roundOff: 0 } : prev);
        }
        return null;
      }
      throw e;
    }
    if (request === previewRequest.current) {
      setBill(preview);
      if (mode === "amt") setDiscPct(Number(preview.discountPct ?? 0).toFixed(2));
      setDiscAmt(rupee(preview.discount ?? 0));
    }
    return preview;
  }

  useEffect(() => {
    let cancel = false;
    previewRequest.current++;
    setReady(false);
    invoiceId.current = existingInvoiceId;
    serviceChargeMode.current = undefined;
    edits.current = [];
    savedRemark.current = "";
    savedApprovalFields.current = billApprovalFields({
      customerDisplayName: guest,
      billDetails: { mobile },
    });
    setName(guest);
    setMob(mobile);
    setPax("1");
    setAddress("");
    setRemark("");
    setRemarkRequired(false);
    setGstin("");
    // This dialog can be reused for another order. Clear all bill-specific
    // discount state before looking up an existing invoice so a previous
    // order's amount/mode/exclusions cannot leak into a new bill.
    discMode.current = "pct";
    wantPct.current = 0;
    wantAmt.current = 0;
    setDiscPct("0.00");
    setDiscAmt("0.00");
    setNoDisc([]);
    setSvcPct(String(DEFAULT_SVC_PCT));
    svcPctDraft.current = String(DEFAULT_SVC_PCT);
    setDelivery("0");
    setBill(null);
    setComp(outlet === "NC");
    setCompId("");
    (async () => {
      let next: Parameters<typeof load>[0] | undefined;
      let existingComplimentary = outlet === "NC";
      try {
        const snap = await api.get<any>(existingInvoiceId
          ? `/api/invoices/${encodeURIComponent(existingInvoiceId)}`
          : `/api/tables/${table.id}/invoice`);
        const inv = snap?.invoice;
        if (inv?.order_id === orderId && !cancel) {
          invoiceId.current = inv.id;
          serviceChargeMode.current = inv.service_charge_mode;
          const details: Partial<BillDetails> = JSON.parse(inv.bill_details || "{}");
          setName(inv.customer_display_name || "");
          setGstin(inv.customer_gstin || "");
          setMob(details.mobile ?? "");
          setPax(details.pax ?? "1");
          setAddress(details.address ?? "");
          savedRemark.current = details.remark ?? "";
          savedApprovalFields.current = billApprovalFields({
            billDetails: details,
            discount: inv.discount,
            otherCharges: inv.other_charges,
            complimentaryAccountId: inv.complimentary_account_id,
            customerDisplayName: inv.customer_display_name,
            customerGstin: inv.customer_gstin,
          });
          const excludeItemIds = details.excludeItemIds ?? [];
          setNoDisc(excludeItemIds);
          existingComplimentary = existingComplimentary || Boolean(inv.complimentary_account_id);
          if (outlet !== "NC") setComp(Boolean(inv.complimentary_account_id));
          setCompId(String(inv.complimentary_account_id || ""));
          const discountAmt = Number(inv.discount ?? 0) / 100;
          // A zero rate is a valid saved value. Only treat a zero rate as a
          // legacy missing value when the old invoice still has a charge.
          const savedPct = Number(inv.service_charge_pct ?? 0);
          const savedServiceCharge = Number(inv.service_charge ?? 0);
          const serviceChargePct = savedPct !== 0 || savedServiceCharge === 0 ? savedPct : DEFAULT_SVC_PCT;
          const otherCharges = Number(inv.other_charges ?? 0) / 100;
          discMode.current = "amt";
          wantAmt.current = discountAmt;
          setDiscAmt(discountAmt.toFixed(2));
          setSvcPct(String(serviceChargePct));
          svcPctDraft.current = String(serviceChargePct);
          setDelivery(String(otherCharges));
          if (details.discountPct != null) {
            discMode.current = "pct";
            wantPct.current = details.discountPct;
            setDiscPct(String(details.discountPct));
          }
          next = { mode: discMode.current, discountAmt, serviceChargePct, otherCharges, excludeItemIds };
        }
      } catch (e) {
        if (cancel) return;
        if (existingInvoiceId || !(e instanceof ApiError && e.status === 404)) {
          onMessage(e instanceof Error ? e.message : "Could not load saved bill");
          return;
        }
      }
      if (cancel) return;
      try {
        await load(next ?? { serviceChargePct: DEFAULT_SVC_PCT, otherCharges: 0, excludeItemIds: [] });
        if (cancel) return;
        setReady(true);
        setTimeout(() => {
          if (existingComplimentary) compRef.current?.focus();
          else { discRef.current?.focus(); discRef.current?.select(); }
        }, 0);
      } catch (e) {
        onMessage(e instanceof Error ? e.message : "Could not open bill");
      }
    })();
    return () => { cancel = true; };
  }, [orderId, outlet, existingInvoiceId]);

  useEffect(() => {
    if (!isComplimentary) return;
    api.get<CompAccount[]>("/api/complimentary").then(setAccounts).catch(() => setAccounts([]));
  }, [isComplimentary]);

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
      return { ...it, qty, unit_price: unit, amount: Math.round(qty * unit) };
    });
    const extra = pending ? Math.round((Number(addQty) || 0) * Number(pending.base_price || 0)) : 0;
    const totalQty = items.reduce((s, it) => s + Number(it.qty), 0) + (pending ? Number(addQty) || 0 : 0);
    if (isComplimentary) {
      return {
        items: items.map((it) => ({ ...it, amount: 0, tax: 0 })),
        estimate: items.reduce((sum, it) => sum + Math.round(Number(it.qty) * Number(it.unit_price)), extra),
        totalQty,
        subtotal: 0,
        tax: 0,
        discountable: 0,
        discount: 0,
        service: 0,
        roundOff: 0,
        grand: 0,
        extra: 0,
      };
    }
    const foodTotal = items.filter((it) => it.station === "KITCHEN").reduce((s, it) => s + Number(it.amount), 0);
    const drinksTotal = items.filter((it) => it.station !== "KITCHEN").reduce((s, it) => s + Number(it.amount), 0) + extra;
    const subtotal = foodTotal + drinksTotal;
    const excluded = new Set(noDisc);
    const taxLines = items.map((it) => ({
      amount: Number(it.amount),
      taxRate: Number(it.tax_rate) || 0,
      excluded: (it.ids ?? [it.id]).some((id: string) => excluded.has(id)),
    }));
    if (extra > 0) taxLines.push({ amount: extra, taxRate: 0, excluded: false });
    const discountable = taxLines.reduce((total, line) => line.excluded ? total : total + line.amount, 0);
    const svcMode = bill?.serviceChargeMode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE";
    const pct = svcPctValue(svcPct);
    const discount = discMode.current === "amt"
      ? Math.max(0, Math.min(Math.round((Number(discAmt) || 0) * 100), discountable))
      : Math.min(discountable, Math.round((discountable * (Number(discPct) || 0)) / 100));
    const tax = billLineTaxes(taxLines, discount, discountable).reduce((total, lineTax) => total + lineTax, 0);
    const other = Math.round((Number(delivery) || 0) * 100);
    const after = Math.max(0, subtotal - discount);
    const service = svcMode === "INCLUSIVE"
      ? Math.round(after - after / (1 + pct / 100))
      : Math.round((after * pct) / 100);
    const unrounded = svcMode === "INCLUSIVE" ? after + tax + other : after + service + tax + other;
    const grand = Math.round(unrounded / 100) * 100;
    return {
      items,
      totalQty,
      subtotal,
      tax,
      discountable,
      discount,
      service,
      roundOff: grand - unrounded,
      grand,
      extra,
    };
  }, [bill, rowSel, editQty, editPrice, addQty, pending, noDisc, svcPct, discPct, discAmt, delivery, isComplimentary]);

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

  function stageEdit(edit: BillLineEdit) {
    const previous = edits.current;
    edits.current = [...previous, edit];
    const preview = load().then(() => true, (error) => {
      edits.current = previous;
      onMessage(error instanceof Error ? error.message : "Could not change bill item");
      return false;
    });
    editPreview.current = preview;
    return preview;
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
    if (!ready || busy.current) return;
    busy.current = true;
    try {
      if (!await stageEdit({ kind: "product", ids: it.ids ?? [it.id], productId: p.id, outlet })) {
        setNameQuery(it.name ?? "");
        return;
      }
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
    if (!ready || busy.current) return;
    busy.current = true;
    try {
      if (!await stageEdit({ kind: "qty", ids: it.ids ?? [it.id], qty })) setEditQty(String(it.qty));
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
    if (!ready || busy.current) return;
    busy.current = true;
    try {
      if (!await stageEdit({ kind: "price", ids: it.ids ?? [it.id], price })) setEditPrice(rupee(it.unit_price));
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not change price");
    } finally {
      busy.current = false;
    }
  }

  async function addLine() {
    if (!pending) {
      setInvalidAddField("item");
      addNameRef.current?.focus();
      return;
    }
    const qty = Number(addQty);
    if (!Number.isInteger(qty) || qty === 0) {
      setInvalidAddField("qty");
      addQtyRef.current?.focus();
      return;
    }
    if (!ready || busy.current) return;
    setInvalidAddField(null);
    busy.current = true;
    try {
      const random = crypto.getRandomValues(new Uint8Array(16));
      const id = "bill-" + Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!await stageEdit({ kind: "add", id, productId: pending.id, qty, outlet })) return;
      setPending(null);
      setAddQuery("");
      setAddOpen(false);
      setAddQty("1");
      requestAnimationFrame(() => {
        if (outlet === "NC") remarkRef.current?.focus();
        else addNameRef.current?.focus();
      });
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
      if (e.key === "Enter" && !e.repeat) printedWithEnter.current = false;
      if (ask || saving || masterOpen || document.querySelector(".cm-dlg, .confirm-dlg, .alert-dlg")) return;
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
      if (e.key === "F10") { e.preventDefault(); e.stopPropagation(); if (!e.repeat) requestAction("print"); }
      if (e.key === "F5") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) requestAction("save");
      }
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

  async function saveBill(pin?: string) {
    if (busy.current) return null;
    busy.current = true;
    try {
      const invoice = await api.post<any>("/api/invoices/generate", {
        orderId,
        invoiceId: invoiceId.current,
        masterPin: pin,
        edits: edits.current,
        serviceChargeMode: serviceChargeMode.current,
        ...billFields(),
        serviceChargePct: isComplimentary ? 0 : svcPctValue(svcPctDraft.current),
        reason: remark.trim() || undefined,
        complimentary: isComplimentary,
      });
      return invoice;
    } catch (e) {
      if (e instanceof ApiError && e.details === "billRemark") {
        highlightRemark();
        return null;
      }
      const message = e instanceof Error ? e.message : "Could not save bill";
      if (pin) {
        setApprovalError(message);
        if (e instanceof ApiError && e.status === 403 && /master PIN/i.test(e.message)) {
          setMasterPin("");
          masterPinRef.current?.focus();
        }
      } else onMessage(message);
      return null;
    } finally {
      busy.current = false;
    }
  }

  async function printInvoice(invoice: { id: string }) {
    const result = await printBill(invoice.id);
    if (!result.ok) onMessage(result.error || "Bill print failed");
  }

  function requestAction(action: "save" | "print") {
    if (!ready || savingRef.current || saving || ask || printChoice) return;
    // Commit the active field to the draft before a keyboard shortcut saves it.
    (document.activeElement as HTMLElement | null)?.blur();
    if (!validateBillFields()) return;
    if ((action === "save" && !isComplimentary) || needsApproval()) {
      setAsk(action);
    } else {
      void finishAction(action);
    }
  }

  async function finishAction(action: "save" | "print", pin?: string) {
    if (savingRef.current || (busy.current && !editPreview.current)) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const pendingEdit = editPreview.current;
      editPreview.current = undefined;
      if (pendingEdit && !await pendingEdit) {
        setAsk(null);
        setPinOpen(false);
        return;
      }
      if (!validateBillFields()) return;
      if (needsApproval() && !pin) {
        setAsk(action);
        setPinOpen(true);
        return;
      }
      const invoice = await saveBill(pin);
      if (!invoice?.id) {
        if (!pin) setAsk(null);
        return;
      }
      closeApproval();
      onChanged?.();
      if (action === "print") await printAndClose(invoice);
      else if (pin || invoiceId.current) setPrintChoice(invoice);
      else if (isComplimentary) onPrinted(invoice);
      else settleAfterSave(invoice);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function printAndClose(invoice: { id: string }) {
    try {
      await printInvoice(invoice);
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Bill print failed");
    }
    onPrinted(invoice);
  }

  function closeApproval() {
    setAsk(null);
    setPinOpen(false);
    setMasterPin("");
    setApprovalError("");
  }

  function settleAfterSave(invoice: any) {
    // Let the Yes key finish so it cannot land on Settlement
    window.setTimeout(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      onSettle(invoice);
    }, 200);
  }

  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, "0")}-${now.toLocaleString("en-GB", { month: "short" })}-${now.getFullYear()}`;
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="dialog bill-dlg">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Restaurant Bill - {formatUiLabel(outlet)}
        <CapBtns onClose={onClose} />
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
                <select className="win" value={shownTableNo(table, outlet)} onChange={() => undefined}>
                  <option>{shownTableNo(table, outlet)}</option>
                </select>
              </td>
              {isComplimentary ? (
                <>
                  <td className="lbl">Compl. A/C :</td>
                  <td colSpan={3}>
                    <div className="name-cell">
                      <select
                        ref={compRef}
                        className="win green"
                        data-cycle="ud"
                        aria-invalid={compRequired && !compId ? true : undefined}
                        value={compId}
                        onChange={(e) => {
                          setCompId(e.target.value);
                          setCompRequired(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          if (!compId) {
                            setCompRequired(true);
                            return;
                          }
                          remarkRef.current?.focus();
                        }}
                      >
                        <option value="" />
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                      <button type="button" className="fn bh-plus" title="Add complimentary account" onClick={() => setMasterOpen(true)}>+</button>
                    </div>
                  </td>
                </>
              ) : (
                <>
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
                </>
              )}
            </tr>
            <tr>
              <td className="lbl">Bill No. :</td>
              <td><input className="win" value={bill?.invoiceNumber ?? ""} readOnly /></td>
              <td className="lbl">Mobile No. :</td>
              {isComplimentary ? (
                <>
                  <td><input className="win" data-num="int" value={mob} onChange={(e) => setMob(e.target.value.replace(/\D/g, ""))} /></td>
                  <td className="lbl">Pax :</td>
                  <td><input className="win" data-num="int" value={pax} onChange={(e) => setPax(e.target.value.replace(/\D/g, ""))} /></td>
                </>
              ) : (
                <td colSpan={3}><input className="win" data-num="int" value={mob} onChange={(e) => setMob(e.target.value.replace(/\D/g, ""))} /></td>
              )}
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
                <label className="chk"><input type="checkbox" checked={isComplimentary} onChange={(e) => {
                  if (nc) return;
                  const enabled = e.target.checked;
                  setComp(enabled);
                  if (enabled) requestAnimationFrame(() => compRef.current?.focus());
                }} /> I want make this complimentary</label>
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
                <th>No.</th><th>Item Name</th><th>Qty</th><th>Item Price</th><th>Tax (%)</th><th>Amount</th><th />
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
                            if (outlet === "NC") {
                              remarkRef.current?.focus();
                              return;
                            }
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
                          void commitPrice(it, raw).then(() => {
                            if (outlet === "NC") remarkRef.current?.focus();
                            else focusLine(next);
                          });
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
                    aria-invalid={invalidAddField === "item" && !pending ? true : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    data-list={addOpen ? "open" : undefined}
                    value={addQuery}
                    onChange={(e) => {
                      const v = e.target.value;
                      setInvalidAddField(null);
                      setPending(null);
                      setAddQuery(v);
                      setAddPick(0);
                      setAddOpen(v.trim().length > 0);
                    }}
                    onKeyDown={(e) => {
                      if (pending && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                        e.preventDefault();
                        setPending(null);
                        setAddQuery(e.key.toUpperCase());
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
                        else if (addQuery.trim()) setInvalidAddField("item");
                      }
                    }}
                  />
                </td>
                <td>
                  <input
                    ref={addQtyRef}
                    className="line"
                    data-num="int"
                    aria-invalid={invalidAddField === "qty" ? true : undefined}
                    value={addQty}
                    onChange={(e) => {
                      setInvalidAddField(null);
                      setAddQty(e.target.value.replace(/\D/g, ""));
                    }}
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
                    <tr><td className="lbl">Remark :</td><td><input ref={remarkRef} className="win" aria-invalid={remarkRequired || undefined} value={remark} onChange={(e) => {
                      setRemark(e.target.value);
                      if (e.target.value.trim()) setRemarkRequired(false);
                    }} onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (validateBillFields()) printRef.current?.focus();
                    }} /></td></tr>
                  </tbody>
                </table>
              </td>
              <td>
                <table className="bill-side">
                  <tbody>
                    {isComplimentary && (
                      <tr><td className="lbl">Table Estimate :</td><td><input className="win" readOnly value={rupee(shown.estimate ?? 0)} /></td></tr>
                    )}
                    <tr><td className="lbl">Total Amount :</td><td><input className="win" readOnly value={rupee(shown.subtotal)} /></td></tr>
                    <tr>
                      <td className="lbl">Discount (%) :</td>
                      <td>
                        <div className="svc">
                          <input
                            ref={discRef}
                            className="win pct green"
                            data-num="dec"
                            value={isComplimentary ? "0.00" : (discMode.current === "amt" ? (shown.discountable ? ((shown.discount / shown.discountable) * 100).toFixed(2) : "0.00") : discPct)}
                            readOnly={isComplimentary}
                            onChange={(e) => { const v = numText(e.target.value); discMode.current = "pct"; wantPct.current = Number(v) || 0; setDiscPct(v); }}
                            onBlur={() => { if (discMode.current === "pct" && !isComplimentary) void load(); }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                if (e.repeat || !validateBillFields()) return;
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
                            value={isComplimentary ? "0.00" : (discMode.current === "amt" ? discAmt : rupee(shown.discount))}
                            readOnly={isComplimentary}
                            onChange={(e) => { const v = numText(e.target.value); discMode.current = "amt"; wantAmt.current = Number(v) || 0; setDiscAmt(v); }}
                            onBlur={() => { if (discMode.current === "amt" && !isComplimentary) void load(); }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                if (e.repeat || !validateBillFields()) return;
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
                            value={isComplimentary ? "0" : svcPct}
                            readOnly={isComplimentary}
                            onChange={(e) => {
                              const value = numText(e.target.value);
                              svcPctDraft.current = value;
                              setSvcPct(value);
                            }}
                            onBlur={(e) => {
                              const serviceChargePct = svcPctValue(e.target.value);
                              svcPctDraft.current = String(serviceChargePct);
                              setSvcPct(String(serviceChargePct));
                              void load({ serviceChargePct });
                            }}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
                              if (e.repeat || !validateBillFields()) return;
                              const serviceChargePct = svcPctValue((e.target as HTMLInputElement).value);
                              svcPctDraft.current = String(serviceChargePct);
                              setSvcPct(String(serviceChargePct));
                              void load({ serviceChargePct }).then(() => printRef.current?.focus());
                            }}
                          />
                          <span>%</span>
                          <input className="win amt" readOnly value={rupee(shown.service)} />
                        </div>
                      </td>
                    </tr>
                    <tr><td className="lbl">Tax Amount :</td><td><input className="win" readOnly value={rupee(shown.tax)} /></td></tr>
                    <tr><td className="lbl">Delivery Charge :</td><td><input className="win" data-num="dec" readOnly={isComplimentary} value={isComplimentary ? "0" : delivery} onChange={(e) => { if (!isComplimentary) setDelivery(numText(e.target.value)); }} onBlur={() => { if (!isComplimentary) void load(); }} /></td></tr>
                    <tr><td className="lbl">Round Off :</td><td><input className="win" readOnly value={rupee(shown.roundOff)} /></td></tr>
                    <tr><td className="lbl">Net Amount :</td><td><input className="win" readOnly value={isComplimentary ? 0 : Math.round(shown.grand / 100)} /></td></tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>

        <div className="bill-btns" style={ask || saving || printChoice ? { pointerEvents: "none" } : undefined}>
          <button ref={printRef} type="button" className="fn" disabled={!ready || Boolean(ask || printChoice) || saving} onKeyDown={(e) => {
            if (e.key !== "Enter") {
              ignoreRepeatedPrintKey(e);
              return;
            }
            e.preventDefault();
            if (printedWithEnter.current) return;
            printedWithEnter.current = true;
            requestAction("print");
          }} onClick={() => requestAction("print")}>Print Bill (F10)</button>
          <button type="button" className="fn" disabled={!ready || Boolean(ask || printChoice) || saving} onClick={() => requestAction("save")}>Save (F5)</button>
          <button type="button" className="fn" onClick={() => void load()}>Print Estimate</button>
          <button type="button" className="fn">Share Bill</button>
          <button type="button" className="fn" onClick={onClose}>Exit</button>
        </div>
      </div>
      {masterOpen && (
        <ComplimentaryMasterDialog
          onClose={() => setMasterOpen(false)}
          onSaved={(row) => {
            setAccounts((prev) => {
              const rest = prev.filter((a) => a.id !== row.id);
              return [...rest, row].sort((a, b) => a.code - b.code);
            });
            setCompId(row.id);
          }}
          onDeleted={(id) => {
            setAccounts((prev) => prev.filter((a) => a.id !== id));
            setCompId((cur) => (cur === id ? "" : cur));
          }}
        />
      )}
      {printChoice && !saving && (
        <ConfirmAsk
          message="Do you want to print bill?"
          defaultFocus="no"
          ignoreEnterMs={250}
          onYes={() => {
            if (savingRef.current) return;
            savingRef.current = true;
            setSaving(true);
            void printAndClose(printChoice).finally(() => {
              savingRef.current = false;
              setPrintChoice(null);
              setSaving(false);
            });
          }}
          onNo={() => {
            if (savingRef.current) return;
            savingRef.current = true;
            setSaving(true);
            settleAfterSave(printChoice);
          }}
        />
      )}
      {ask && !pinOpen && !saving && (
        <ConfirmAsk
          message={needsApproval() ? "Do you want to update bill?" : "Do you want to save?"}
          allowHeldEnter={ask === "print" && printedWithEnter.current}
          onYes={() => {
            if (!validateBillFields()) return;
            if (needsApproval()) setPinOpen(true);
            else void finishAction(ask);
          }}
          onNo={closeApproval}
        />
      )}
      {ask && pinOpen && createPortal(
        <div className="confirm-overlay">
          <form className="dialog confirm-dlg" role="dialog" aria-modal="true" aria-label="Master PIN"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !saving) {
                e.preventDefault();
                e.stopPropagation();
                closeApproval();
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!saving && masterPin) void finishAction(ask, masterPin);
            }}>
            <div className="dialog-cap"><span className="cap-dot" />Master PIN</div>
            <div className="dialog-body">
              <label>Enter master PIN <input className="win" type="password" inputMode="numeric" required
                aria-invalid={Boolean(approvalError) || undefined}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || masterPin) return;
                  e.preventDefault();
                  setApprovalError("Enter master PIN");
                }}
                ref={masterPinRef} autoFocus autoComplete="off" value={masterPin} onChange={(e) => {
                  setMasterPin(e.target.value);
                  setApprovalError("");
                }} /></label>
              {approvalError && <p role="alert">{approvalError}</p>}
              <div className="bill-btns">
                <button className="fn" type="submit" disabled={saving || !masterPin}>OK</button>
                <button className="fn" type="button" disabled={saving} onClick={closeApproval}>Cancel</button>
              </div>
            </div>
          </form>
        </div>, document.body
      )}
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
  const [payCard, setPayCard] = useState(cardNoDigits(cardNo));
  const [payBal, setPayBal] = useState("");
  const [todayCards, setTodayCards] = useState<TodayCard[]>([]);
  const [cardListOpen, setCardListOpen] = useState(false);
  const [cardPick, setCardPick] = useState(0);
  const [cardDrop, setCardDrop] = useState({ top: 0, left: 0, width: 280 });
  const [bankName, setBankName] = useState(BANK_NAMES[0]);
  const [warn, setWarn] = useState("");
  const warnBack = useRef<"amount" | "mode" | "bank" | "card" | "save">("amount");
  const amtRef = useRef<HTMLInputElement>(null);
  const payCardRef = useRef<HTMLInputElement>(null);
  const bankRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<HTMLInputElement>(null);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const cardDropRef = useRef<HTMLDivElement>(null);
  const methodRef = useRef<PaymentMode>("CASH");
  const bankValueRef = useRef(BANK_NAMES[0]);
  const busy = useRef(false);
  const cardListOpenRef = useRef(false);
  const cardPickRef = useRef(0);
  const cardPickedRef = useRef(false);
  const skipCardOpenRef = useRef(false);
  const payCardRefValue = useRef(cardNo);
  payCardRefValue.current = payCard;
  cardListOpenRef.current = cardListOpen;
  cardPickRef.current = cardPick;

  function cardSuggestReady(value = payCardRefValue.current) {
    return value.trim().length >= 4;
  }

  const cardMatches = useMemo(() => {
    const q = payCard.trim().toLowerCase();
    if (q.length < 4) return [];
    return todayCards.filter((c) => c.card_number.toLowerCase().startsWith(q));
  }, [payCard, todayCards]);
  const cardMatchesRef = useRef(cardMatches);
  cardMatchesRef.current = cardMatches;

  function focusField(where: "amount" | "mode" | "bank" | "card" | "save") {
    if (where === "amount") {
      amtRef.current?.focus();
      amtRef.current?.select();
    } else if (where === "mode") modeRef.current?.focus();
    else if (where === "bank") bankRef.current?.focus();
    else if (where === "card") {
      payCardRef.current?.focus();
      payCardRef.current?.select();
    } else saveBtnRef.current?.focus();
  }

  function showWarn(message: string, back: "amount" | "mode" | "bank" | "card" | "save") {
    warnBack.current = back;
    setWarn(message);
  }

  function chooseMode(next: PaymentMode) {
    methodRef.current = next;
    setMethod(next);
    if (next === "CARD" && !BANK_NAMES.includes(bankValueRef.current)) {
      bankValueRef.current = BANK_NAMES[0];
      setBankName(BANK_NAMES[0]);
    }
    if (next !== "MEMBER_CARD") setPayBal("");
  }

  function stepMode(dir: 1 | -1) {
    const i = PAY_MODES.findIndex((m) => m.id === methodRef.current);
    const next = PAY_MODES[Math.max(0, Math.min(PAY_MODES.length - 1, (i < 0 ? 0 : i) + dir))];
    if (next) chooseMode(next.id);
  }

  function stepBank(dir: 1 | -1) {
    const i = Math.max(0, BANK_NAMES.indexOf(bankValueRef.current));
    const next = BANK_NAMES[Math.max(0, Math.min(BANK_NAMES.length - 1, i + dir))];
    if (!next || next === bankValueRef.current) return;
    bankValueRef.current = next;
    setBankName(next);
  }

  function afterMode() {
    const mode = methodRef.current;
    if (mode === "CARD") window.setTimeout(() => bankRef.current?.focus(), 0);
    else if (mode === "MEMBER_CARD") window.setTimeout(() => {
      payCardRef.current?.focus();
      payCardRef.current?.select();
      setCardListOpen(cardSuggestReady());
    }, 0);
    else window.setTimeout(() => saveBtnRef.current?.focus(), 0);
  }

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

  const holdExcept = outlet === "THE BOSS CLUB" ? String(snap?.invoice?.order_id || "") : "";

  useEffect(() => {
    if (method !== "MEMBER_CARD") {
      setCardListOpen(false);
      return;
    }
    let gone = false;
    const q = holdExcept ? `?exceptOrderId=${encodeURIComponent(holdExcept)}` : "";
    api.get<TodayCard[]>(`/api/cards/recharged-today${q}`).then((rows) => {
      if (gone) return;
      setTodayCards(rows);
      if (document.activeElement === payCardRef.current && cardSuggestReady()) setCardListOpen(true);
    }).catch(() => { if (!gone) setTodayCards([]); });
    return () => { gone = true; };
  }, [method, holdExcept]);

  useLayoutEffect(() => {
    if (!cardListOpen) return;
    const el = payCardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = { top: r.bottom, left: r.left, width: Math.max(280, r.width) };
    setCardDrop((prev) => (prev.top === next.top && prev.left === next.left && prev.width === next.width ? prev : next));
  }, [cardListOpen, payCard, cardMatches.length]);

  useLayoutEffect(() => {
    const box = cardDropRef.current;
    const row = box?.children[cardPick] as HTMLElement | undefined;
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
    }
  }, [cardPick, cardListOpen, cardMatches.length]);

  function chosenCardNumber() {
    const typed = payCardRefValue.current.trim();
    if (!cardSuggestReady(typed)) return typed;
    const list = cardMatchesRef.current;
    const exact = list.find((c) => c.card_number.toLowerCase() === typed.toLowerCase());
    if (exact) return exact.card_number;
    if (!typed) {
      if (cardListOpenRef.current && list.length) {
        return list[Math.min(cardPickRef.current, list.length - 1)]?.card_number ?? "";
      }
      return "";
    }
    if (cardListOpenRef.current && list.length) {
      return list[Math.min(Math.max(0, cardPickRef.current), list.length - 1)]?.card_number ?? typed;
    }
    return typed;
  }

  function moveCardPick(dir: 1 | -1) {
    if (!cardSuggestReady()) return;
    const list = cardMatchesRef.current;
    if (!list.length) return;
    if (!cardListOpenRef.current) {
      setCardListOpen(true);
      setCardPick(0);
      cardPickedRef.current = true;
      return;
    }
    setCardPick((cur) => Math.min(list.length - 1, Math.max(0, cur + dir)));
    cardPickedRef.current = true;
  }

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (warn) return;
      if (e.key === "Escape") {
        if (cardListOpenRef.current && document.activeElement === payCardRef.current) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setCardListOpen(false);
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (e.key === "F2") { e.preventDefault(); e.stopImmediatePropagation(); void save(); return; }
      if (e.key === "F4") { e.preventDefault(); e.stopImmediatePropagation(); onClose(); return; }
      const active = document.activeElement;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (active === payCardRef.current && cardMatchesRef.current.length) {
          e.preventDefault();
          e.stopImmediatePropagation();
          moveCardPick(dir);
        } else if (active === modeRef.current) {
          e.preventDefault();
          e.stopImmediatePropagation();
          stepMode(dir);
        } else if (active === bankRef.current) {
          e.preventDefault();
          e.stopImmediatePropagation();
          stepBank(dir);
        }
        return;
      }
      if (e.key !== "Enter") return;
      if (active === amtRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        modeRef.current?.focus();
      } else if (active === modeRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        afterMode();
      } else if (active === bankRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        saveBtnRef.current?.focus();
      } else if (active === payCardRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void acceptCard();
      } else if (active === saveBtnRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void save();
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  async function save(cardOverride?: string) {
    if (busy.current || !snap) return;
    const due = dueOf(snap);
    let paise = 0;
    try { paise = parseRupeesInput(amount || "0"); } catch { showWarn("Enter settle amount", "amount"); return; }
    if (paise <= 0) { showWarn("Enter settle amount", "amount"); return; }
    if (paise > due) paise = due;
    if (method === "CARD" && !bankName) {
      showWarn("Select bank name", "bank");
      return;
    }
    let cardRaw = (cardOverride ?? (method === "MEMBER_CARD" ? chosenCardNumber() : payCard)).trim();
    if (!cardNoReady(cardRaw)) cardRaw = cardNoDigits(cardRaw);
    if (method === "MEMBER_CARD" && !cardNoReady(cardRaw)) {
      stayOnCard(payCardRef.current);
      return;
    }
    busy.current = true;
    try {
      let memberCardId: string | undefined;
      let payPaise = paise;
      if (method === "MEMBER_CARD") {
        try {
          const params = new URLSearchParams({ q: cardRaw });
          if (holdExcept) params.set("exceptOrderId", holdExcept);
          const b = await api.get<any>(`/api/cards/balance/check?${params}`);
          memberCardId = b.card?.id as string | undefined;
          const usable = Number(b.balances?.available ?? b.balances?.usable ?? 0);
          const number = String(b.card?.card_number || cardRaw);
          setPayCard(number);
          setPayBal(rupee(usable));
          if (!memberCardId) {
            showWarn("Card not found", "card");
            busy.current = false;
            return;
          }
          if (usable <= 0) {
            showWarn(`Insufficient amount  Card balance : ${rupee(usable)}`, "amount");
            busy.current = false;
            return;
          }
          payPaise = Math.min(usable, paise);
          if (payPaise !== paise) setAmount(rupee(payPaise));
        } catch (e) {
          showWarn(e instanceof Error ? e.message : "Card not found", "card");
          busy.current = false;
          return;
        }
      }
      setCardListOpen(false);
      const result = await api.post<any>(`/api/invoices/${invoiceId}/pay`, {
        lines: [{
          method,
          amount: payPaise,
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
      chooseMode(PAY_MODES[0].id);
      bankValueRef.current = BANK_NAMES[0];
      setBankName(BANK_NAMES[0]);
      setTimeout(() => { amtRef.current?.focus(); amtRef.current?.select(); }, 0);
    } catch (e) {
      showWarn(insufficientCard(e), method === "MEMBER_CARD" ? "amount" : "save");
    } finally {
      busy.current = false;
    }
  }

  async function acceptCard() {
    let number = chosenCardNumber().trim();
    if (!cardNoReady(number)) number = cardNoDigits(number);
    if (!cardNoReady(number)) { stayOnCard(payCardRef.current); return; }
    setCardListOpen(false);
    if (number !== payCardRefValue.current) setPayCard(number);
    await save(number);
  }

  const inv = snap?.invoice;
  const due = dueOf(snap);
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, "0")}-${now.toLocaleString("en-GB", { month: "short" })}-${now.getFullYear()} ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

  return (
    <div className="dialog settle-dlg">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Restaurant Settlement - {formatUiLabel(outlet)}
        <CapBtns onClose={onClose} />
      </div>
      <div className="settle-body">
        <table className="st-form">
          <colgroup>
            <col className="l" /><col /><col className="l" /><col />
          </colgroup>
          <tbody>
            <tr>
              <td className="lbl">Bill No. :</td>
              <td><input className="win" readOnly tabIndex={-1} value={inv?.invoice_number ?? ""} /></td>
              <td className="lbl">Date :</td>
              <td><input className="win" readOnly tabIndex={-1} value={dateStr} /></td>
            </tr>
            <tr>
              <td className="lbl">Guest Name :</td>
              <td><input className="win" readOnly tabIndex={-1} value={table.customer_name ?? inv?.customer_name ?? ""} /></td>
              <td className="lbl">Table No :</td>
              <td><input className="win" readOnly tabIndex={-1} value={shownTableNo(table, outlet)} /></td>
            </tr>
            <tr>
              <td className="lbl">Voucher/Receipt :</td>
              <td><input className="win" readOnly tabIndex={-1} value={inv?.invoice_number?.replace(/\D/g, "") ?? ""} /></td>
              <td className="lbl">Bill Amount :</td>
              <td><input className="win num" readOnly tabIndex={-1} value={rupee(inv?.grand_total ?? 0)} /></td>
            </tr>
            <tr>
              <td className="lbl">Allowance :</td>
              <td><input className="win num" readOnly tabIndex={-1} value={rupee(inv?.discount ?? 0)} /></td>
              <td className="lbl">Payment Mode :</td>
              <td>
                <span className="st-drop">
                  <input
                    ref={modeRef}
                    className="win"
                    readOnly
                    tabIndex={2}
                    data-cycle="1"
                    value={PAY_MODES.find((m) => m.id === method)?.label ?? "Cash"}
                  />
                  <span className="st-drop-btn" aria-hidden="true" />
                </span>
              </td>
            </tr>
            {method === "CARD" && (
              <tr>
                <td /><td />
                <td className="lbl">Bank Name :</td>
                <td>
                  <span className="st-drop">
                    <input
                      ref={bankRef}
                      className="win"
                      readOnly
                      tabIndex={3}
                      data-cycle="1"
                      value={bankName}
                    />
                    <span className="st-drop-btn" aria-hidden="true" />
                  </span>
                </td>
              </tr>
            )}
            {method === "MEMBER_CARD" && (
              <tr>
                <td /><td />
                <td className="lbl">Card No. :</td>
                <td>
                  <span className="st-card">
                    <span className="st-drop">
                      <input
                        ref={payCardRef}
                        className="win green"
                        tabIndex={3}
                        autoComplete="off"
                        data-num="card"
                        inputMode="numeric"
                        maxLength={4}
                        value={payCard}
                        onChange={(e) => {
                          const next = cardNoDigits(e.target.value);
                          setPayCard(next);
                          setCardPick(0);
                          cardPickedRef.current = false;
                          setCardListOpen(cardSuggestReady(next));
                          setPayBal("");
                        }}
                        onFocus={() => {
                          if (skipCardOpenRef.current) {
                            skipCardOpenRef.current = false;
                            return;
                          }
                          setCardListOpen(cardSuggestReady());
                        }}
                        onBlur={() => window.setTimeout(() => {
                          if (document.activeElement === payCardRef.current) return;
                          const typed = cardNoDigits(payCardRefValue.current);
                          if (typed && !cardNoReady(typed)) {
                            stayOnCard(payCardRef.current);
                            return;
                          }
                          setCardListOpen(false);
                        }, 160)}
                      />
                      <button
                        type="button"
                        className="st-drop-btn card-drop-open"
                        tabIndex={-1}
                        aria-label="Cards recharged today"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          if (!cardSuggestReady()) {
                            setCardListOpen(false);
                            payCardRef.current?.focus();
                            return;
                          }
                          setCardListOpen((open) => {
                            if (open) skipCardOpenRef.current = true;
                            return !open;
                          });
                          payCardRef.current?.focus();
                        }}
                      />
                    </span>
                    {payBal ? <span className="st-bal">{payBal}</span> : null}
                  </span>
                </td>
              </tr>
            )}
            <tr>
              <td className="lbl">Settled Amount :</td>
              <td>
                <input
                  ref={amtRef}
                  className="win green num"
                  data-num="dec"
                  tabIndex={1}
                  autoFocus
                  value={amount}
                  onChange={(e) => setAmount(numText(e.target.value))}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </td>
              <td className="lbl">Balance Amount :</td>
              <td><input className="win num" readOnly tabIndex={-1} value={rupee(Math.max(0, due - Math.round((Number(amount) || 0) * 100)))} /></td>
            </tr>
            <tr>
              <td className="lbl">Remark :</td>
              <td colSpan={3}><input className="win" tabIndex={-1} value={remark} onChange={(e) => setRemark(e.target.value)} /></td>
            </tr>
          </tbody>
        </table>
        <div className="st-foot">
          <span className="st-vno">Voucher No : {inv?.invoice_number ?? ""}</span>
          <button type="button" className="fn" tabIndex={-1} onKeyDown={ignoreRepeatedPrintKey} onClick={() => {
            void printBill(invoiceId).catch(() => null);
          }}>Print</button>
          <button ref={saveBtnRef} type="button" className="fn" tabIndex={4} onClick={() => void save()}>Save (F2)</button>
          <button type="button" className="fn" tabIndex={-1} onClick={onClose}>Cancel (F4)</button>
          <button type="button" className="fn" tabIndex={-1} onClick={onClose}>Exit</button>
        </div>
      </div>
      {cardListOpen && method === "MEMBER_CARD" && cardMatches.length > 0 && createPortal(
        <div
          ref={cardDropRef}
          className="card-drop"
          style={{ top: cardDrop.top, left: cardDrop.left, width: cardDrop.width }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {cardMatches.map((c, i) => (
            <div
              key={c.id}
              className={i === cardPick ? "on" : ""}
              onMouseEnter={() => setCardPick(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                cardPickedRef.current = true;
                const picked = cardNoDigits(c.card_number);
                setPayCard(picked);
                setCardListOpen(false);
                if (!cardNoReady(picked)) { stayOnCard(payCardRef.current); return; }
                void save(picked);
              }}
            >
              <span className="no">{c.card_number}</span>
              <span className="nm">{c.customer_name}</span>
              <span className="bal">{rupee(c.available ?? c.usable)}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
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
    </div>
  );
}

/** Double-click punch row → per-item kitchen note shown as NAME (notes) on grid + KOT. */
export function ItemNotesDialog({
  itemName,
  initialNotes,
  onSave,
  onClose,
}: {
  itemName: string;
  initialNotes: string;
  onSave: (notes: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef(notes);
  const saveRef = useRef(onSave);
  const closeRef = useRef(onClose);
  notesRef.current = notes;
  saveRef.current = onSave;
  closeRef.current = onClose;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void (async () => {
          setBusy(true);
          try {
            await saveRef.current(notesRef.current);
          } finally {
            setBusy(false);
          }
        })();
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, []);

  return (
    <div className="dialog alert-dlg item-notes-dlg">
      <div className="dialog-cap">
        <span className="cap-dot" />
        Item Notes
        <CapBtns onClose={onClose} chrome={false} />
      </div>
      <div className="dialog-body">
        <p style={{ marginBottom: 8 }}>{itemName}</p>
        <div className="su-row" style={{ marginBottom: 10 }}>
          <span style={{ width: 56 }}>Notes :</span>
          <input
            ref={inputRef}
            className="win green"
            value={notes}
            maxLength={80}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="bill-btns">
          <button
            type="button"
            className="fn"
            disabled={busy}
            onClick={() => {
              void (async () => {
                setBusy(true);
                try {
                  await onSave(notesRef.current);
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            OK
          </button>
          <button type="button" className="fn" disabled={busy} onClick={onClose}>Cancel</button>
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
      if (e.key === "Enter" && e.repeat) return;
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
        <CapBtns onClose={onClose} chrome={false} />
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
  defaultFocus = "yes",
  ignoreEnterMs = 0,
  allowHeldEnter = false,
}: {
  message?: string;
  onYes: () => void;
  onNo: () => void;
  defaultFocus?: "yes" | "no";
  /** Ignore Enter/Y for this many ms after open (stops Save? Enter from answering Print?). */
  ignoreEnterMs?: number;
  allowHeldEnter?: boolean;
}) {
  const yesRef = useRef<HTMLButtonElement>(null);
  const noRef = useRef<HTMLButtonElement>(null);
  const yes = useRef(onYes);
  const no = useRef(onNo);
  const openedAt = useRef(Date.now());
  yes.current = onYes;
  no.current = onNo;
  useEffect(() => {
    openedAt.current = Date.now();
    const focusEl = defaultFocus === "no" ? noRef.current : yesRef.current;
    focusEl?.focus();
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        e.stopPropagation();
        no.current();
        return;
      }
      if (e.key === "Enter" || e.key === "y" || e.key === "Y") {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat && !(allowHeldEnter && e.key === "Enter" && document.activeElement === yesRef.current)) return;
        if (Date.now() - openedAt.current < ignoreEnterMs) return;
        // Enter activates focused button (No when print ask defaults to No)
        if (document.activeElement === noRef.current) no.current();
        else yes.current();
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [defaultFocus, ignoreEnterMs, allowHeldEnter]);

  function pick(which: "yes" | "no", e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Avoid click-through onto controls under the dialog
    window.setTimeout(() => {
      if (which === "yes") yes.current();
      else no.current();
    }, 0);
  }

  return createPortal(
    <div className="confirm-overlay" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div className="dialog confirm-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-cap">
          <span className="cap-dot" />
          Confirm
          <CapBtns onClose={() => no.current()} chrome={false} />
        </div>
        <div className="dialog-body">
          <p>{message}</p>
          <div className="bill-btns">
            <button ref={yesRef} type="button" className="fn" onMouseDown={(e) => pick("yes", e)}>Yes</button>
            <button ref={noRef} type="button" className="fn" onMouseDown={(e) => pick("no", e)}>No</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
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
  /** Destination outlet (New Table). Source table is found across all outlets. */
  const [dept, setDept] = useState(outlet === "THE BOSS CLUB" ? "THE BOSS CLUB" : outlet || "BAR");
  const [fromCode, setFromCode] = useState(currentCode);
  const [toCode, setToCode] = useState("");
  const [reason, setReason] = useState("");
  const [reasonNeed, setReasonNeed] = useState(false);
  const fromRef = useRef<HTMLInputElement>(null);
  const outletRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const xferRef = useRef<HTMLButtonElement>(null);
  const OUTLETS = ["BAR", "RESTAURANT", "NC", "THE BOSS CLUB"] as const;
  // Printed / settlement tables cannot transfer — only open running tables.
  const occupiedAll = tables.filter((t) => t.status !== "AVAILABLE" && t.status !== "PAYMENT_PENDING");

  function stepOutlet(dir: 1 | -1) {
    setDept((cur) => {
      const i = OUTLETS.indexOf(cur as (typeof OUTLETS)[number]);
      const idx = i < 0 ? 0 : i;
      const next = Math.max(0, Math.min(OUTLETS.length - 1, idx + dir));
      return OUTLETS[next];
    });
  }

  /** First letter: B=BAR, R=RESTAURANT, N=NC, T=THE BOSS CLUB; same letter cycles matches. */
  function pickOutletByChar(ch: string) {
    const c = ch.toUpperCase();
    if (!c || c.length !== 1) return false;
    const matches = OUTLETS.filter((o) => o.toUpperCase().startsWith(c));
    if (!matches.length) return false;
    setDept((cur) => {
      const i = matches.indexOf(cur as (typeof OUTLETS)[number]);
      if (i >= 0 && matches.length > 1) return matches[(i + 1) % matches.length];
      return matches[0];
    });
    return true;
  }

  useEffect(() => {
    const running = currentCode && occupiedAll.some((t) => t.code.toLowerCase() === currentCode.trim().toLowerCase());
    const el = running ? outletRef.current : fromRef.current;
    el?.focus();
    el?.select();
  }, [currentCode]);

  useEffect(() => {
    function onOutlet() {
      return outletRef.current && document.activeElement === outletRef.current;
    }
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (!onOutlet()) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        stepOutlet(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (pickOutletByChar(e.key)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
    }
    // Capture before formNav moveFormFocus (registered earlier) — still need data-cycle skip there.
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

  function onOutletKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      stepOutlet(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (pickOutletByChar(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      toRef.current?.focus();
    }
  }

  /** Find running source table: prefer current billing outlet, else any outlet. */
  function findRunning(code: string) {
    const raw = code.trim().toLowerCase();
    if (!raw) return undefined;
    const matches = occupiedAll.filter((t) => t.code.toLowerCase() === raw);
    if (!matches.length) return undefined;
    return matches.find((t) => (t.outlet || "BAR") === outlet) ?? matches[0];
  }

  function acceptCurrent() {
    if (!fromCode.trim()) {
      onMessage("Enter Current Table No");
      fromRef.current?.focus();
      return undefined;
    }
    const raw = fromCode.trim().toLowerCase();
    const printed = tables.find(
      (t) => t.code.toLowerCase() === raw && t.status === "PAYMENT_PENDING",
    );
    if (printed) {
      onMessage("Printed bill table cannot be transferred");
      fromRef.current?.focus();
      fromRef.current?.select();
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

  function acceptNewTable(from: Table) {
    const toRaw = toCode.trim();
    if (!toRaw) {
      onMessage("Enter New Table No");
      toRef.current?.focus();
      return false;
    }
    const sameOutlet = (from.outlet || "BAR") === dept;
    if (sameOutlet && from.code.toLowerCase() === toRaw.toLowerCase()) {
      onMessage("Cannot transfer a table to itself");
      toRef.current?.focus();
      toRef.current?.select();
      return false;
    }
    onMessage("");
    return true;
  }

  async function transfer() {
    const from = acceptCurrent();
    if (!from) return;
    if (!acceptNewTable(from)) return;
    const why = reason.trim();
    if (!why) {
      setReasonNeed(true);
      reasonRef.current?.focus();
      reasonRef.current?.select();
      return;
    }
    setReasonNeed(false);
    const toRaw = toCode.trim();
    try {
      let to = tables.find((t) => t.code.toLowerCase() === toRaw.toLowerCase() && (t.outlet || "BAR") === dept);
      if (!to) to = await api.post<Table>("/api/tables", { code: toRaw, name: `Table ${toRaw}`, outlet: dept });
      if (to.id === from.id) {
        onMessage("Cannot transfer a table to itself");
        return;
      }
      await api.post("/api/tables/transfer", { fromTableId: from.id, toTableId: to.id, reason: why });
      onDone(from.code, to);
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Transfer failed");
    }
  }

  return (
    <div className="xfer-dlg">
      <div className="dialog-cap xfer-cap">
        <span className="cap-dot" />
        Table Transfer
        <CapBtns onClose={onClose} chrome={false} />
      </div>
      <div className="xfer-main">
      <div className="xfer-form">
        <div className="xfer-row">
          <span>Current Table No :</span>
          <input
            ref={fromRef}
            className="win green"
            value={fromCode}
            onChange={(e) => setFromCode(e.target.value)}
            onKeyDown={onEnter(() => { if (acceptCurrent()) outletRef.current?.focus(); })}
            autoComplete="off"
          />
        </div>
        <div className="xfer-row xfer-outlet">
          <span>Outlet :</span>
          <input
            ref={outletRef}
            className="win xfer-outlet-box"
            readOnly
            data-cycle="1"
            value={dept}
            onFocus={(e) => e.target.select()}
            onKeyDown={onOutletKeyDown}
            onClick={() => stepOutlet(1)}
            title="Up/Down or B/R/N/T"
          />
          <span>New Table No :</span>
          <input
            ref={toRef}
            className="win"
            value={toCode}
            onChange={(e) => setToCode(e.target.value)}
            onKeyDown={onEnter(() => {
              const from = acceptCurrent();
              if (!from) return;
              if (acceptNewTable(from)) reasonRef.current?.focus();
            })}
            autoComplete="off"
          />
        </div>
        <div className="xfer-row">
          <span>Reason :</span>
          <input
            ref={reasonRef}
            className={`win xfer-reason${reasonNeed ? " need" : ""}`}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (e.target.value.trim()) setReasonNeed(false);
            }}
            onKeyDown={onEnter(() => {
              if (!reason.trim()) {
                setReasonNeed(true);
                reasonRef.current?.focus();
                reasonRef.current?.select();
                return;
              }
              void transfer();
            })}
          />
        </div>
      </div>
      <div className="xfer-btns">
        <button ref={xferRef} type="button" className="fn" onClick={() => void transfer()} onKeyDown={onEnter(() => void transfer())}>Transfer</button>
        <button type="button" className="fn" onClick={onClose}>Cancel</button>
      </div>
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
  /** Today's open tables only (not free, not bill-printed / settlement). */
  const openTables = tables.filter(
    (t) =>
      (t.outlet || "BAR") === outlet &&
      (t.status === "OCCUPIED" || t.status === "BILL_REQUESTED"),
  );
  const occupied = openTables;

  function findRunning(code: string) {
    const raw = code.trim().toLowerCase();
    if (!raw) return undefined;
    return openTables.find((t) => t.code.toLowerCase() === raw);
  }

  function findOpenDest(code: string, fromId: string) {
    const raw = code.trim().toLowerCase();
    if (!raw) return undefined;
    return openTables.find((t) => t.code.toLowerCase() === raw && t.id !== fromId);
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
    const to = findOpenDest(toRaw, from.id);
    if (!to) {
      onMessage("New Table No not found (open tables only)");
      toRef.current?.focus();
      toRef.current?.select();
      return;
    }
    const itemIds = rows.filter((r) => checked[r.id]).map((r) => r.id);
    if (!itemIds.length) { onMessage("Select items to transfer"); return; }
    busy.current = true;
    try {
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
      <div className="dialog-cap xfer-cap">
        <span className="cap-dot" />
        Item Transfer
        <CapBtns onClose={onClose} chrome={false} />
      </div>
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
              {openTables
                .filter((t) => t.code.toLowerCase() !== fromCode.trim().toLowerCase())
                .map((t) => <option key={t.id} value={t.code} />)}
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
