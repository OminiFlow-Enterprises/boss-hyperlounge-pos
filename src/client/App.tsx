import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { formatINR } from "../shared/money";
import type { NavView, PaymentMode, StaffRole } from "../shared/types";
import { ReportHost } from "./Reports";
import { ConfirmAsk, ItemTransferDialog, PrepareBillDialog, PrepareTablePick, SettleDialog, TransferDialog } from "./BillDialogs";
import { ItemMasterDialog } from "./ItemMaster";

type Actor = { staffId: string; staffName: string; role: StaffRole; terminalId: string; terminalName: string };
type Table = {
  id: string; code: string; name: string; status: string; floor_name: string; floor_id: string;
  current_session_id: string | null; customer_name?: string; card_number?: string; running_total?: number;
  session_opened_at?: string; outlet?: string;
};

type Dept = "CLUB" | "RESTAURANT" | "NC" | "BAR";

function deptOutlet(d: Dept) {
  return d === "CLUB" ? "THE BOSS CLUB" : d;
}
type Product = {
  id: string; name: string; station: string; base_price: number; sku: string;
  item_group?: string;
  dept_rates?: Record<string, { rate: number; enabled: number }>;
};

const TAB_ITEM_GROUPS: Record<Dept, string[] | null> = {
  BAR: ["BAR", "BEVERAGE"],
  RESTAURANT: ["FOOD"],
  CLUB: ["EV CAFE", "EV FOOD", "SPL", "SPL1"],
  NC: null,
};

function priceForOutlet(p: Product, outletName: string) {
  const row = p.dept_rates?.[outletName];
  if (!row || Number(row.enabled) === 0) return p.base_price;
  return Number(row.rate) > 0 ? Number(row.rate) : p.base_price;
}

function onThisTab(p: Product, dept: Dept) {
  const group = (p.item_group || "").trim().toUpperCase();
  if (!group) return true;
  const allowed = TAB_ITEM_GROUPS[dept];
  if (!allowed) return true;
  return allowed.some((name) => name.toUpperCase() === group);
}
type Card = {
  id: string; card_number: string; customer_name: string; mobile: string; paid_balance: number;
  bonus_balance: number; status: string; card_type_code: string; last_used_at?: string;
};
type OrderItem = {
  id: string; product_id?: string; sku?: string; name: string; qty: number;
  unit_price: number; station: string; notes?: string; kot_id?: string;
};
type Invoice = {
  id: string; invoice_number: string; grand_total: number; food_total: number; drinks_total: number;
  service_charge: number; discount: number; tax: number; other_charges: number; status: string; table_id: string;
};

type AppView = NavView | "login" | "billing";
type MenuLeaf = { label: string; view: AppView; outlet?: string };
type MenuNode = { label: string; children?: MenuLeaf[]; view?: AppView; outlet?: string };

const DEPT_LEAVES: MenuLeaf[] = [
  { label: "KOT", view: "billing" },
  { label: "Settlement", view: "history" },
  { label: "KOT Report", view: "kot-report" },
  { label: "Bill Report", view: "bill-report" },
  { label: "Settlement Report", view: "settlement-report" },
];

const MENUS: Array<{ id: string; label: string; items: MenuNode[] }> = [
  {
    id: "fnb",
    label: "F n B",
    items: [
      { label: "BAR", children: DEPT_LEAVES.map((x) => ({ ...x, outlet: "BAR" })) },
      { label: "NC", children: DEPT_LEAVES.map((x) => ({ ...x, outlet: "NC" })) },
      { label: "RESTAURANT", children: DEPT_LEAVES.map((x) => ({ ...x, outlet: "RESTAURANT" })) },
      { label: "THE BOSS CLUB", children: DEPT_LEAVES.map((x) => ({ ...x, outlet: "THE BOSS CLUB" })) },
      { label: "Advance Booking", children: [
        { label: "Booking", view: "advance-booking" },
        { label: "Card Block", view: "card-block" },
        { label: "Booking Report", view: "booking-report" },
        { label: "Settlement Report", view: "settlement-report", outlet: "THE BOSS CLUB" },
      ] },
    ],
  },
  {
    id: "report",
    label: "Report",
    items: [
      { label: "F n B", children: [
        { label: "GST Report", view: "gst-report" },
        { label: "Point Of Sales", view: "point-of-sales" },
        { label: "Item Wise Sales", view: "item-wise-sale" },
        { label: "Item Wise Sales Detail", view: "item-wise-detail" },
      ] },
      { label: "Sales Report", children: [
        { label: "Item Combine Stock Report", view: "item-combine-stock" },
        { label: "Outlet Wise Stock Report", view: "outlet-stock" },
        { label: "Item Wise Sale", view: "item-wise-sale" },
        { label: "GST Report", view: "gst-report" },
        { label: "Time Sale Report", view: "time-sale" },
        { label: "Tax Wise Report", view: "tax-wise" },
        { label: "Settlement Report", view: "settlement-report" },
      ] },
    ],
  },
];

const VIEW_TITLE: Partial<Record<AppView, string>> = {
  billing: "BAR (Restaurant)",
  "gst-report": "FnB GST Report",
  "point-of-sales": "FnB Point Of Sales",
  "item-wise-sale": "Item Wise Sale",
  "item-wise-detail": "Item Wise Sales Detail",
  "item-combine-stock": "Item Combine Stock Report",
  "outlet-stock": "Outlet Wise Stock Report",
  "time-sale": "Time Sale Report",
  "tax-wise": "Tax Wise Report",
  "kot-report": "KOT Report",
  "bill-report": "Bill Report",
  "settlement-report": "Restaurant Settlement Report",
  "booking-report": "Restaurant Booking Register",
  "advance-booking": "Restaurant Advance Booking",
  "card-block": "Card Block",
  history: "Bill Report",
  login: "User Login",
};

function formatWinDate(d: Date) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dd = String(d.getDate()).padStart(2, "0");
  let h = d.getHours();
  const am = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const hh = String(h).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd}-${months[d.getMonth()]}-${d.getFullYear()} ${hh}:${mm}:${ss} ${am}`;
}

export function App() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [view, setView] = useState<AppView>("billing");
  const [bootstrap, setBootstrap] = useState<any>(null);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [sub, setSub] = useState<string | null>(null);
  const [outlet, setOutlet] = useState("BAR");
  const [invoice, setInvoice] = useState<any>(null);
  const [msg, setMsg] = useState("");

  async function refresh() {
    const data = await api.get<any>("/api/bootstrap");
    setBootstrap(data);
    if (!actor) setActor(data.actor);
  }

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  function go(next: AppView, nextOutlet?: string) {
    setView(next);
    if (nextOutlet) setOutlet(nextOutlet);
    setMenu(null);
    setSub(null);
  }

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (document.querySelector(".su-dlg, .confirm-dlg")) return;
      if (view === "billing" || view === "advance-booking" || view === "card-block") {
        if (view === "billing" && menu) {
          e.preventDefault();
          e.stopPropagation();
          setMenu(null);
          setSub(null);
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      go("billing");
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [view, menu]);

  if (!bootstrap) {
    return (
      <div className="winapp">
        <div className="caption"><div className="caption-icon" /><div className="caption-title">Organisation : THE BOSS</div></div>
        <div className="login-dlg outset">Loading…</div>
      </div>
    );
  }

  const deptLabel = view === "settlement-report"
    ? `Restaurant Settlement Report - ${outlet}`
    : view === "kot-report"
      ? `${outlet} KOT Report`
      : (VIEW_TITLE[view] ?? outlet);

  return (
    <div className="winapp" onClick={() => { setMenu(null); setSub(null); }}>
      <header className="caption">
        <div className="caption-icon" />
        <div className="caption-title">
          Organisation : THE BOSS&nbsp;&nbsp;&nbsp;&nbsp;Session :2026-27&nbsp;&nbsp;&nbsp;&nbsp;Version : 1.0.0&nbsp;&nbsp;&nbsp;&nbsp;- [{deptLabel}]
        </div>
        <div className="caption-btns">
          <button type="button">─</button>
          <button type="button">☐</button>
          <button type="button" className="cap-close">✕</button>
        </div>
      </header>
      <nav className="menubar" onClick={(e) => e.stopPropagation()}>
        {MENUS.map((m) => (
          <button
            key={m.id}
            className={menu === m.id ? "open" : ""}
            onClick={() => { setMenu(menu === m.id ? null : m.id); setSub(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                setMenu(m.id);
                setSub(null);
              }
            }}
          >
            {m.label}
          </button>
        ))}
        <button onClick={() => go("login")}>Logout</button>
        {menu && (
          <div className="menu-flyout" style={{ left: menu === "fnb" ? 4 : 56 }}>
            {MENUS.find((m) => m.id === menu)?.items.map((item) => (
              <div
                key={item.label}
                className="menu-item-wrap"
                onMouseEnter={() => item.children && setSub(item.label)}
              >
                {item.children ? (
                  <button
                    type="button"
                    className={`mi ${sub === item.label ? "open" : ""}`}
                    onFocus={() => setSub(item.label)}
                    onMouseEnter={() => setSub(item.label)}
                  >
                    {item.label}<span className="arrow">▸</span>
                  </button>
                ) : (
                  <button type="button" onClick={() => go(item.view!, item.outlet)}>{item.label}</button>
                )}
                {item.children && sub === item.label && (
                  <div className="menu-sub">
                    {item.children.map((child) => (
                      <button key={child.label} type="button" onClick={() => go(child.view, child.outlet)}>
                        {child.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </nav>

      {view === "billing" && (
        <BillingScreen
          tables={bootstrap.tables}
          products={bootstrap.products}
          outlet={outlet}
          onRefresh={refresh}
          onInvoice={setInvoice}
          onMessage={setMsg}
          onOpenView={go}
        />
      )}

      {view !== "billing" && view !== "login" && (
        <div className={`workarea ${["card-block","advance-booking","booking-report","item-wise-sale","settlement-report","kot-report","bill-report","history","item-combine-stock","outlet-stock","time-sale","tax-wise"].includes(view) ? "plain" : ""}`}>
          {view === "kot" && <div className="rpt-page plain" style={{ padding: 8 }}><KotBoard /></div>}
          {view === "kitchen" && <div className="rpt-page plain" style={{ padding: 8 }}><KotBoard station="KITCHEN" /></div>}
          {view === "bar" && <div className="rpt-page plain" style={{ padding: 8 }}><KotBoard station="BAR" /></div>}
          <ReportHost view={view as NavView} outlet={outlet} onExit={() => go("billing")} />
        </div>
      )}

      {view === "login" && (
        <div className="dialog">
          <div className="dialog-cap">
            USER LOGIN
            <button type="button" onClick={() => go("billing")}>✕</button>
          </div>
          <div className="dialog-body">
            <LoginForm actor={actor} onLogin={(a) => { setActor(a); go("billing"); }} terminalId={bootstrap.actor.terminalId} />
          </div>
        </div>
      )}
      {error && <div className="flash" style={{ padding: 4 }}>{error}</div>}
      {msg && <div className="meta" style={{ padding: "2px 8px" }}>{msg}</div>}
    </div>
  );
}

function BillingScreen({ tables, products, outlet, onRefresh, onInvoice, onMessage, onOpenView }: {
  tables: Table[];
  products: Product[];
  outlet: string;
  onRefresh: () => void;
  onInvoice: (inv: any) => void;
  onMessage: (m: string) => void;
  onOpenView: (v: AppView, nextOutlet?: string) => void;
}) {
  const [now, setNow] = useState(new Date());
  const [tableId, setTableId] = useState("");
  const [tableCode, setTableCode] = useState("");
  const [orderId, setOrderId] = useState<string | null>(null);
  const tableRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLInputElement>(null);
  const itemRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const remarkRef = useRef<HTMLInputElement>(null);
  const kotBtnRef = useRef<HTMLButtonElement>(null);
  const gridBodyRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<any>(null);
  const [dept, setDept] = useState<Dept>(outlet === "THE BOSS CLUB" ? "CLUB" : outlet === "RESTAURANT" ? "RESTAURANT" : outlet === "NC" ? "NC" : "BAR");
  const clubMode = dept === "CLUB";
  const [mobile, setMobile] = useState("");
  const [guest, setGuest] = useState("");
  const [cardNo, setCardNo] = useState("");
  const [cardBal, setCardBal] = useState("0.00");
  const [sel, setSel] = useState(-1);
  const [focusEntry, setFocusEntry] = useState(0);
  const [remark, setRemark] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState<"bill" | "settle" | null>(null);
  const [billOrder, setBillOrder] = useState<{ orderId: string; table: Table } | null>(null);
  const [settleInv, setSettleInv] = useState<{ invoiceId: string; table: Table } | null>(null);
  const [settleTables, setSettleTables] = useState<Table[]>([]);
  const [askExit, setAskExit] = useState(false);
  const [xferOpen, setXferOpen] = useState(false);
  const [itemXferOpen, setItemXferOpen] = useState(false);
  const [itemMasterOpen, setItemMasterOpen] = useState(false);
  const [waiter, setWaiter] = useState("A");
  const [itemQuery, setItemQuery] = useState("");
  const [qtyStr, setQtyStr] = useState("1");
  const [pending, setPending] = useState<Product | null>(null);
  const [nameLocked, setNameLocked] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [pick, setPick] = useState(0);
  const [itemListSel, setItemListSel] = useState(0);
  const [dropPos, setDropPos] = useState({ top: 0, left: 58 });
  const amt = (n: number) => (n / 100).toFixed(2);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (outlet === "THE BOSS CLUB") setDept("CLUB");
    else if (outlet === "RESTAURANT") setDept("RESTAURANT");
    else if (outlet === "NC") setDept("NC");
    else setDept("BAR");
  }, [outlet]);

  useEffect(() => {
    if (dept === "CLUB") cardRef.current?.focus();
    else tableRef.current?.focus();
  }, [dept]);

  const table = tables.find((t) => t.id === tableId);
  const allItems: OrderItem[] = detail?.items ?? [];
  const items: OrderItem[] = allItems.filter((it) => !it.kot_id);
  const tableItemList = useMemo(() => {
    const map = new Map<string, { code: string; name: string; qty: number }>();
    for (const it of (detail?.items ?? []) as OrderItem[]) {
      if (!it.kot_id) continue;
      const key = it.product_id || it.name;
      const code = it.sku || products.find((p) => p.id === it.product_id)?.sku || "";
      const cur = map.get(key);
      if (cur) cur.qty += it.qty;
      else map.set(key, { code, name: it.name, qty: it.qty });
    }
    return [...map.values()];
  }, [detail, products]);
  const kotNo = String(detail?.kots?.[0]?.kot_number ?? "").replace(/\D/g, "");

  const catalog = useMemo(() => {
    const outletName = deptOutlet(dept);
    return products
      .filter((p) => {
        if (!onThisTab(p, dept)) return false;
        const row = p.dept_rates?.[outletName];
        if (!row) return true;
        return Number(row.enabled) !== 0;
      })
      .map((p) => ({ ...p, base_price: priceForOutlet(p, outletName) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, dept]);

  const matches = useMemo(() => {
    const v = itemQuery.trim().toLowerCase();
    if (!v) return [];
    const starts = catalog.filter((p) => p.name.toLowerCase().startsWith(v));
    if (starts.length) return starts;
    return catalog.filter((p) => p.name.toLowerCase().includes(v));
  }, [catalog, itemQuery]);

  async function loadOrder(id: string) {
    const d = await api.get<any>(`/api/orders/${id}`);
    setDetail(d);
    return d;
  }

  async function selectTable(id: string, code?: string) {
    setTableId(id);
    if (code) setTableCode(code);
    const t = tables.find((x) => x.id === id);
    try {
      if (!t || t.status === "AVAILABLE") {
        await api.post(`/api/tables/${id}/open`, { outlet: deptOutlet(dept) }).catch(() => null);
      }
      const order = await api.post<any>("/api/orders", { tableId: id });
      setOrderId(order.id);
      setItemListSel(0);
      await loadOrder(order.id);
      if (t?.customer_name) setGuest(t.customer_name);
      if (t?.card_number) setCardNo(t.card_number);
      onRefresh();
      itemRef.current?.focus();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not open table");
    }
  }

  function switchDept(next: Dept) {
    if (next === dept) return;
    setDept(next);
    setOrderId(null);
    setDetail(null);
    setTableId("");
    setTableCode("");
    setPending(null);
    setNameLocked(false);
    setItemQuery("");
    setQtyStr("1");
    setRemark("");
    setListOpen(false);
    setPick(0);
    setItemListSel(0);
    setCardNo("");
    setCardBal("0.00");
    setSel(-1);
    setTimeout(() => {
      if (next === "CLUB") cardRef.current?.focus();
      else tableRef.current?.focus();
    }, 0);
  }

  async function ensureOpenByCode(code: string) {
    const raw = code.trim();
    if (clubMode && !cardNo.trim()) {
      onMessage("Enter Card No first");
      cardRef.current?.focus();
      return null;
    }
    if (!raw) {
      onMessage("Select Table No first");
      return null;
    }
    const out = deptOutlet(dept);
    const current = tables.find((x) => x.id === tableId);
    if (orderId && current && current.code.toLowerCase() === raw.toLowerCase() && (current.outlet || "BAR") === out) {
      itemRef.current?.focus();
      return current;
    }
    try {
      let t = tables.find((x) => x.code.toLowerCase() === raw.toLowerCase() && (x.outlet || "BAR") === out);
      if (!t) t = await api.post<Table>("/api/tables", { code: raw, name: `Table ${raw}`, outlet: out });
      await selectTable(t.id, t.code);
      return t;
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not open table");
      return null;
    }
  }

  async function loadCard(q: string) {
    const v = q.trim();
    setCardNo(q);
    if (!v) {
      setCardBal("0.00");
      if (clubMode) onMessage("Enter Card No first");
      return false;
    }
    try {
      const b = await api.get<any>(`/api/cards/balance/check?q=${encodeURIComponent(v)}`);
      setCardBal(amt(b.balances.usable));
      if (b.card.customer_name) setGuest(b.card.customer_name);
      if (b.card.mobile && !String(b.card.mobile).startsWith("card-")) setMobile(b.card.mobile);
      return true;
    } catch {
      setCardBal("0.00");
      onMessage("Card not found");
      return false;
    }
  }

  function placeDrop() {
    const body = gridBodyRef.current;
    const entry = body?.querySelector(".igrid-row.entry") as HTMLElement | null;
    if (!body || !entry) return;
    const b = body.getBoundingClientRect();
    const r = entry.getBoundingClientRect();
    setDropPos({
      top: Math.max(0, r.bottom - b.top - 1),
      left: 58,
    });
  }

  function listForPick() {
    return matches;
  }

  function parseQty(raw: string) {
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n === 0) return null;
    return n;
  }

  function movePick(delta: number) {
    const list = listForPick();
    if (!list.length) return;
    const cur = Math.min(Math.max(0, pick), list.length - 1);
    const next = Math.min(list.length - 1, Math.max(0, cur + delta));
    const p = list[next];
    setPick(next);
    if (itemQuery.trim()) setListOpen(true);
    if (p && nameLocked) {
      setPending(p);
      setItemQuery(p.name);
    }
  }

  function bumpQty(delta: number) {
    setQtyStr((q) => {
      const cur = Number(q);
      const from = Number.isFinite(cur) && cur !== 0 ? cur : 1;
      const next = from + delta;
      if (next === 0) return delta > 0 ? "1" : "-1";
      return String(next);
    });
  }

  function movePending(delta: number) {
    if (!nameLocked && pending) setNameLocked(true);
    if (!pending && catalog[pick]) {
      setPending(catalog[pick]);
      setItemQuery(catalog[pick].name);
      setNameLocked(true);
    }
    movePick(delta);
    setSel(items.length);
  }

  function moveRow(delta: number) {
    const last = items.length;
    const cur = sel < 0 || sel > last ? last : sel;
    const next = Math.min(last, Math.max(0, cur + delta));
    setSel(next);
    if (next === last) {
      if (pending) {
        qtyRef.current?.focus();
        qtyRef.current?.select();
      } else itemRef.current?.focus();
      gridBodyRef.current?.querySelector(".igrid-row.entry")?.scrollIntoView({ block: "nearest" });
    } else {
      const row = gridBodyRef.current?.querySelectorAll(".igrid-row:not(.entry)")[next] as HTMLElement | undefined;
      row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    }
  }

  function focusQty() {
    setTimeout(() => {
      qtyRef.current?.focus();
      qtyRef.current?.select();
    }, 0);
  }

  function chooseItem(product: Product) {
    const list = catalog;
    const idx = list.findIndex((p) => p.id === product.id);
    setPick(idx < 0 ? 0 : idx);
    setPending(product);
    setItemQuery(product.name);
    setNameLocked(true);
    setListOpen(false);
    setQtyStr("1");
    focusQty();
  }

  async function addItem(product: Product, qty = 1, next: "item" | "none" = "item") {
    if (clubMode && !cardNo.trim()) {
      onMessage("Enter Card No first");
      cardRef.current?.focus();
      return false;
    }
    if (!orderId) {
      onMessage("Select Table No first");
      tableRef.current?.focus();
      return false;
    }
    const n = Number.isInteger(qty) && qty !== 0 ? qty : parseQty(String(qty)) ?? 1;
    if (n > 0 && cardNo.trim()) {
      try {
        const b = await api.get<any>(`/api/cards/balance/check?q=${encodeURIComponent(cardNo.trim())}`);
        const usable = Number(b.balances?.usable ?? 0);
        const line = product.base_price * n;
        const running = (table?.running_total as number)
          || allItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
          || 0;
        if (usable < running + line) {
          onMessage(`Insufficient amount  Card balance : ${(usable / 100).toFixed(2)}`);
          return false;
        }
        setCardBal(amt(usable));
      } catch {
        onMessage("Card not found");
        return false;
      }
    }
    try {
      await api.post(`/api/orders/${orderId}/items`, { productId: product.id, qty: n, notes: remark || undefined });
      setPending(null);
      setNameLocked(false);
      setItemQuery("");
      setQtyStr("1");
      setListOpen(false);
      const d = await loadOrder(orderId);
      setSel((d.items ?? []).filter((it: OrderItem) => !it.kot_id).length);
      onRefresh();
      if (next === "item") setFocusEntry((x) => x + 1);
      return true;
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not add item");
      return false;
    }
  }

  async function commitQty() {
    if (!pending) {
      itemRef.current?.focus();
      return;
    }
    const n = parseQty(qtyStr) ?? 1;
    const ok = await addItem(pending, n, "item");
    if (ok) {
      setTimeout(() => itemRef.current?.focus(), 0);
    }
  }

  async function printKot() {
    let id = orderId;
    if (pending) {
      const n = parseQty(qtyStr) ?? 1;
      const ok = await addItem(pending, n, "none");
      if (!ok) return;
      id = orderId;
    }
    if (!id) {
      onMessage("No items to print");
      return;
    }
    try {
      await api.post(`/api/orders/${id}/send-kot`);
      await loadOrder(id);
      setRemark("");
      setPending(null);
      setItemQuery("");
      setQtyStr("1");
      setNameLocked(false);
      setListOpen(false);
      onRefresh();
      onMessage("KOT printed");
      setFocusEntry((x) => x + 1);
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "KOT failed");
    }
  }

  function goMainBilling() {
    setPayOpen(false);
    setPickOpen(null);
    setBillOrder(null);
    setSettleInv(null);
    setXferOpen(false);
    setItemXferOpen(false);
    setListOpen(false);
    setPending(null);
    setNameLocked(false);
    setItemQuery("");
    setQtyStr("1");
    setRemark("");
    setPick(0);
    setItemListSel(0);
    setOrderId(null);
    setDetail(null);
    setTableId("");
    setTableCode("");
    setCardNo("");
    setCardBal("0.00");
    setGuest("");
    setMobile("");
    setSel(-1);
    onRefresh();
    setTimeout(() => {
      if (dept === "CLUB") cardRef.current?.focus();
      else tableRef.current?.focus();
    }, 0);
  }

  async function abandonPunch() {
    if (orderId) {
      const current = items;
      for (const it of current) {
        await api.post(`/api/order-items/${it.id}/cancel`, { reason: "ESC" }).catch(() => null);
      }
    }
    goMainBilling();
  }

  function isDraft() {
    return items.length > 0 || Boolean(pending) || Boolean(itemQuery.trim()) || Boolean(remark.trim());
  }

  function requestExit() {
    if (isDraft()) setAskExit(true);
    else void abandonPunch();
  }

  const runningForBill = tables.filter((t) => {
    if ((t.outlet || "BAR") !== deptOutlet(dept)) return false;
    if (t.status === "AVAILABLE" || t.status === "PAYMENT_PENDING") return false;
    return ((t.running_total as number) || 0) > 0 || t.id === tableId;
  });

  function prepareBill() {
    if (!runningForBill.length) {
      onMessage("No running table");
      return;
    }
    setListOpen(false);
    setPickOpen("bill");
  }

  async function openBillForTable(t: Table) {
    try {
      const order = await api.post<any>("/api/orders", { tableId: t.id });
      setPickOpen(null);
      setBillOrder({ orderId: order.id, table: t });
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not prepare bill");
    }
  }

  async function openSettleForTable(t: Table) {
    try {
      const snap = await api.get<any>(`/api/tables/${t.id}/invoice`);
      setPickOpen(null);
      setSettleInv({ invoiceId: snap.invoice.id, table: t });
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "No bill to settle");
    }
  }

  async function openSettlement() {
    setListOpen(false);
    const byStatus = tables.filter((t) => t.status === "PAYMENT_PENDING" && (t.outlet || "BAR") === deptOutlet(dept));
    if (byStatus.length) {
      setSettleTables(byStatus);
      setPickOpen("settle");
      return;
    }
    try {
      const invoices = await api.get<any[]>("/api/invoices");
      const open = invoices.filter((i) => i.status === "UNPAID" || i.status === "PARTIAL");
      const mapped: Table[] = [];
      for (const inv of open) {
        const t = tables.find((x) => x.id === inv.table_id);
        if (t && (t.outlet || "BAR") !== deptOutlet(dept)) continue;
        const row = t ?? { id: inv.table_id, code: inv.table_code, status: "PAYMENT_PENDING", name: inv.table_code, floor_name: "", floor_id: "", current_session_id: null, outlet: deptOutlet(dept) };
        if (!mapped.some((x) => x.id === row.id)) mapped.push(row);
      }
      if (!mapped.length) {
        onMessage("No printed bill to settle");
        return;
      }
      setSettleTables(mapped);
      setPickOpen("settle");
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "No printed bill to settle");
    }
  }

  useLayoutEffect(() => {
    if (listOpen) placeDrop();
  }, [listOpen, itemQuery, items.length, pick]);

  useEffect(() => {
    if (!listOpen) return;
    const el = dropRef.current?.querySelector(".on") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [listOpen, pick]);

  useEffect(() => {
    const n = listForPick().length;
    if (pick >= n) setPick(n ? n - 1 : 0);
  }, [matches.length, catalog.length, pending, nameLocked]);

  useLayoutEffect(() => {
    if (!focusEntry) return;
    itemRef.current?.focus();
    gridBodyRef.current?.querySelector(".igrid-row.entry")?.scrollIntoView({ block: "nearest" });
  }, [focusEntry, items.length]);

  useEffect(() => {
    function isF11(ev: KeyboardEvent) {
      return ev.key === "F11" || ev.code === "F11" || ev.keyCode === 122;
    }
    function isF10(ev: KeyboardEvent) {
      return ev.key === "F10" || ev.code === "F10" || ev.keyCode === 121;
    }
    function keys(e: KeyboardEvent) {
      if (askExit) return;
      if (itemMasterOpen) {
        if (e.key.startsWith("F") && e.key.length > 1) e.preventDefault();
        return;
      }
      const fn = e.code || e.key;
      if (isF11(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (settleInv) return;
        if (billOrder) return;
        if (pickOpen === "settle") return;
        if (xferOpen || itemXferOpen) return;
        void openSettlement();
        return;
      }
      if (e.key === "F9" || e.code === "F9") {
        e.preventDefault();
        e.stopPropagation();
        if (!pickOpen && !billOrder && !settleInv && !xferOpen && !itemXferOpen) setXferOpen(true);
        return;
      }
      if (isF10(e) || fn === "F10") {
        e.preventDefault();
        e.stopPropagation();
        if (!pickOpen && !billOrder && !settleInv && !xferOpen && !itemXferOpen) prepareBill();
        return;
      }
      if (e.altKey && e.key === "1") { e.preventDefault(); switchDept("CLUB"); }
      if (e.altKey && e.key === "2") { e.preventDefault(); switchDept("RESTAURANT"); }
      if (e.altKey && e.key === "3") { e.preventDefault(); switchDept("NC"); }
      if (e.altKey && e.key === "4") { e.preventDefault(); switchDept("BAR"); }
      if (e.key === "F3" || e.code === "F3") {
        e.preventDefault();
        e.stopPropagation();
        if (!pickOpen && !billOrder && !settleInv && !xferOpen && !itemXferOpen) setItemMasterOpen(true);
        return;
      }
      if (pickOpen || billOrder || settleInv || xferOpen || itemXferOpen) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (payOpen) setPayOpen(false);
        else requestExit();
      }
      if (e.key === "F1") { e.preventDefault(); onMessage("Complimentary"); }
      if (e.key === "F4") { e.preventDefault(); onMessage("Packing"); }
      if (e.key === "F5" || e.key === "F6" || e.key === "F16") { e.preventDefault(); void printKot(); }
      if (e.key === "F7") { e.preventDefault(); onOpenView("kot-report"); }
      if (e.key === "F8") { e.preventDefault(); onOpenView("bill-report"); }
      if (e.key === "F12") { e.preventDefault(); onOpenView("settlement-report", deptOutlet(dept)); }
    }
    function up(e: KeyboardEvent) {
      if (isF11(e)) e.preventDefault();
    }
    window.addEventListener("keydown", keys, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", keys, true);
      window.removeEventListener("keyup", up, true);
    };
  });

  const dayStart = new Date();
  if (dayStart.getHours() < 6) dayStart.setDate(dayStart.getDate() - 1);
  dayStart.setHours(6, 0, 0, 0);
  const occupied = tables.filter((t) => {
    if ((t.outlet || "BAR") !== deptOutlet(dept)) return false;
    if (t.status === "AVAILABLE") return false;
    if (!(((t.running_total as number) || 0) > 0 || t.id === tableId)) return false;
    if (t.session_opened_at && new Date(t.session_opened_at) < dayStart) return false;
    return true;
  });
  const estimateRows = occupied;
  const listTotal = estimateRows.reduce((s, t) => s + ((t.running_total as number) || 0), 0);
  const grand = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const tableEstimate = (table?.running_total as number)
    || allItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
    || grand;
  const showTableItems = Boolean(tableId) && table?.status !== "PAYMENT_PENDING";

  return (
    <div className="billing">
      <div className="billing-main">
        <div className="header-row">
          <div className="hdr">
            <span className="lbl">Date</span>
            <input className="win" value={formatWinDate(now)} readOnly tabIndex={-1} />
            <span className="lbl">KOT No</span>
            <span className="kot-text">{kotNo}</span>
            {clubMode && (
              <>
                <span>Card No</span>
                <input
                  ref={cardRef}
                  className="win green"
                  value={cardNo}
                  tabIndex={1}
                  autoFocus
                  onChange={(e) => setCardNo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    void loadCard(cardNo).then((ok) => {
                      if (!ok) { cardRef.current?.focus(); return; }
                      tableRef.current?.focus();
                      tableRef.current?.select();
                    });
                  }}
                />
              </>
            )}
            <span>Table No</span>
            <input
              ref={tableRef}
              className="win green"
              value={tableCode}
              tabIndex={clubMode ? 2 : 1}
              autoFocus={!clubMode}
              onChange={(e) => setTableCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  ensureOpenByCode(tableCode);
                }
              }}
            />
          </div>

          <div className="dept-box">
            <div className="dept-yellow">{dept}</div>
            <div className="dept-body">
              <button type="button" className={`dept-btn ${dept === "CLUB" ? "active" : ""}`} title="Alt+1" onClick={() => switchDept("CLUB")}>THE BOSS<br />CLUB</button>
              <button type="button" className={`dept-btn ${dept === "RESTAURANT" ? "active" : ""}`} title="Alt+2" onClick={() => switchDept("RESTAURANT")}>RESTAURAN<br />T</button>
              <button type="button" className={`dept-btn ${dept === "NC" ? "active" : ""}`} title="Alt+3" onClick={() => switchDept("NC")}>NC</button>
              <button type="button" className={`dept-btn ${dept === "BAR" ? "active" : ""}`} title="Alt+4" onClick={() => switchDept("BAR")}>BAR</button>
              <div className="card-pane">
                <span>Card No. :</span>
                {clubMode ? (
                  <input className="win" style={{ width: 70 }} value={cardNo} readOnly tabIndex={-1} />
                ) : (
                  <input
                    ref={cardRef}
                    className="win"
                    style={{ width: 70 }}
                    value={cardNo}
                    tabIndex={3}
                    title="Balance check"
                    onChange={(e) => setCardNo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void loadCard(cardNo);
                      }
                    }}
                    onBlur={() => { if (cardNo.trim()) void loadCard(cardNo); }}
                  />
                )}
                <span>{cardBal}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="igrid">
          <div className="igrid-head">
            <div>Sr.No.</div>
            <div>ItemName</div>
            <div>Rate</div>
            <div>Qty</div>
          </div>
          <div className="igrid-body" ref={gridBodyRef}>
            {items.map((it, i) => (
              <div
                key={it.id}
                className="igrid-row"
                tabIndex={0}
                onClick={() => setSel(i)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    moveRow(-1);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveRow(1);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    itemRef.current?.focus();
                  }
                }}
              >
                <div>{i + 1}</div>
                <div className={`cell-name ${sel === i ? "sel" : ""}`}>{it.name}{it.notes ? ` (${it.notes})` : ""}</div>
                <div>{amt(it.unit_price)}</div>
                <div>{it.qty}</div>
              </div>
            ))}
            <div className="igrid-row entry" onClick={() => setSel(items.length)}>
              <div>{items.length + 1}</div>
              <div className={`cell-name ${nameLocked && !listOpen ? "" : "sel"}`}>
                <input
                  ref={itemRef}
                  autoComplete="off"
                  spellCheck={false}
                  tabIndex={4}
                  style={{ width: "100%" }}
                  value={itemQuery}
                  onChange={(e) => {
                    const v = e.target.value;
                    setItemQuery(v);
                    setNameLocked(false);
                    setPending(null);
                    setPick(0);
                    setListOpen(v.trim().length > 0);
                  }}
                  onFocus={() => {
                    if (nameLocked) return;
                    if (itemQuery.trim()) setListOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Backspace" && nameLocked) {
                      e.preventDefault();
                      e.stopPropagation();
                      setNameLocked(false);
                      setListOpen(false);
                      return;
                    }
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      e.stopPropagation();
                      movePick(1);
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      e.stopPropagation();
                      movePick(-1);
                    } else if (e.key === "Enter" || e.key === "Tab") {
                      const list = listForPick();
                      const chosen = list[pick] ?? list[0];
                      if (chosen && (itemQuery.trim() || listOpen)) {
                        e.preventDefault();
                        e.stopPropagation();
                        chooseItem(chosen);
                      } else if (pending) {
                        e.preventDefault();
                        e.stopPropagation();
                        focusQty();
                      } else if (!itemQuery.trim()) {
                        e.preventDefault();
                        e.stopPropagation();
                        setListOpen(false);
                        remarkRef.current?.focus();
                      }
                    }
                  }}
                />
              </div>
              <div>{pending ? amt(pending.base_price) : ""}</div>
              <div className="cell-qty">
                {pending && (
                  <input
                    ref={qtyRef}
                    autoComplete="off"
                    inputMode="numeric"
                    tabIndex={5}
                    value={qtyStr}
                    onChange={(e) => setQtyStr(e.target.value.replace(/[^\d-]/g, "").replace(/(?!^)-/g, ""))}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowLeft") {
                        e.preventDefault();
                        e.stopPropagation();
                        movePending(-1);
                      } else if (e.key === "ArrowRight") {
                        e.preventDefault();
                        e.stopPropagation();
                        movePending(1);
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        e.stopPropagation();
                        movePending(-1);
                      } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        e.stopPropagation();
                        movePending(1);
                      } else if (e.key === "+" || e.key === "=") {
                        e.preventDefault();
                        bumpQty(1);
                      } else if (e.key === "-" || e.key === "_") {
                        e.preventDefault();
                        bumpQty(-1);
                      } else if (e.key === "Backspace") {
                        const el = e.currentTarget;
                        const allSelected = el.selectionStart === 0 && el.selectionEnd === el.value.length;
                        if (allSelected || qtyStr === "1" || qtyStr === "-1" || qtyStr === "") {
                          e.preventDefault();
                          itemRef.current?.focus();
                        }
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        void commitQty();
                      }
                    }}
                  />
                )}
              </div>
            </div>
            {listOpen && listForPick().length > 0 && (
              <div
                ref={dropRef}
                className="item-drop"
                style={{ top: dropPos.top, left: dropPos.left }}
                onMouseDown={(e) => e.preventDefault()}
              >
                {listForPick().map((p, i) => (
                  <div
                    key={p.id}
                    className={i === pick ? "on" : ""}
                    onMouseEnter={() => setPick(i)}
                    onClick={() => chooseItem(p)}
                  >
                    {p.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="fn-box">
          <div className="remark">Remark : <input
            ref={remarkRef}
            className="win"
            tabIndex={6}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                e.stopPropagation();
                kotBtnRef.current?.focus();
              }
            }}
          /></div>
          <div className="fn-row">
            <button className="fn" onClick={prepareBill}>Prepare Bill (F10)</button>
            <button className="fn" onClick={openSettlement}>Settlement (F11)</button>
            <button
              ref={kotBtnRef}
              className="fn"
              tabIndex={7}
              onClick={() => void printKot()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  void printKot();
                }
              }}
            >Print KOT (F16)</button>
            <button className="fn" onClick={printKot}>Save (F5)</button>
            <button className="fn" onClick={() => onMessage("Packing")}>Packing (F4)</button>
            <button className="fn" onClick={() => onMessage("Complimentary")}>F1 Complim.</button>
            <button className="fn" onClick={() => onOpenView("kot")}>Hold KOT</button>
            <button className="fn" onClick={requestExit}>Exit</button>
          </div>
          <div className="fn-row">
            <button className="fn" onClick={() => onOpenView("kot-report")}>KOT Rep. (F7)</button>
            <button className="fn" onClick={() => onOpenView("bill-report")}>Bill Rep. (F8)</button>
            <button className="fn" onClick={() => onOpenView("settlement-report", deptOutlet(dept))}>S. Report (F12)</button>
            <button className="fn" onClick={() => setItemXferOpen(true)}>Item transfer</button>
            <button className="fn" onClick={() => setXferOpen(true)}>T. Transfer (F9)</button>
            <button className="fn" onClick={() => setItemMasterOpen(true)}>Create Item (F3)</button>
            <button className="fn" onClick={() => onOpenView("kot")}>Load Hold</button>
            <button className="fn">Table</button>
          </div>
        </div>
      </div>

      <aside className={`estimate ${showTableItems ? "item-list" : ""}`}>
        {showTableItems ? (
          <>
            <div className="estimate-head">Table No. Items List</div>
            <table>
              <colgroup><col className="c-code" /><col /><col className="c-qty" /></colgroup>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>ItemName</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {tableItemList.map((row, i) => (
                  <tr
                    key={`${row.code}-${row.name}`}
                    className={i === itemListSel ? "on" : ""}
                    tabIndex={0}
                    onClick={() => setItemListSel(i)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setItemListSel((s) => Math.min(tableItemList.length - 1, s + 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setItemListSel((s) => Math.max(0, s - 1));
                      }
                    }}
                  >
                    <td>{row.code}</td>
                    <td>{row.name}</td>
                    <td className="qty">{row.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="estimate-fill" />
            <div className="estimate-total">Estimate: {Math.round((tableEstimate || 0) / 100)}</div>
          </>
        ) : (
          <>
            <div className="estimate-head">Table Estimate [F10 Prepare Bill]</div>
            <table>
              <colgroup><col className="c1" /><col className="c2" /><col /></colgroup>
              <thead>
                <tr>
                  <th>TableNo</th>
                  <th>Estimate</th>
                  <th>Bill/Settle</th>
                </tr>
              </thead>
              <tbody>
                {estimateRows.map((t) => {
                  const settle = t.status === "PAYMENT_PENDING";
                  const cls = t.id === tableId ? "sel" : settle ? "settle" : "occ";
                  return (
                    <tr
                      key={t.id}
                      className={cls}
                      tabIndex={0}
                    onClick={() => {
                      if (settle) void openSettleForTable(t);
                      else void openBillForTable(t);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (settle) void openSettleForTable(t);
                        else void openBillForTable(t);
                      }
                    }}
                    >
                      <td>{t.code}</td>
                      <td>{settle ? amt((t.running_total as number) || 0) : Math.round(((t.running_total as number) || 0) / 100)}</td>
                      <td>{settle ? "Settlement" : "Bill"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="estimate-fill" />
            <div className="estimate-total">Total Amount : {amt(listTotal || grand)}</div>
          </>
        )}
      </aside>

      {askExit && (
        <ConfirmAsk
          message="Exit without save?"
          onYes={() => { setAskExit(false); void abandonPunch(); }}
          onNo={() => setAskExit(false)}
        />
      )}
      {xferOpen && (
        <TransferDialog
          tables={tables}
          outlet={deptOutlet(dept)}
          currentCode={tableCode}
          onClose={() => setXferOpen(false)}
          onDone={(fromCode, to) => {
            setXferOpen(false);
            onRefresh();
            onMessage(`Transferred ${fromCode} to ${to.code}`);
            if (tableCode.toLowerCase() === fromCode.toLowerCase()) {
              setTableId(to.id);
              setTableCode(to.code);
              void selectTable(to.id, to.code);
            }
          }}
          onMessage={onMessage}
        />
      )}
      {itemXferOpen && (
        <ItemTransferDialog
          tables={tables}
          outlet={deptOutlet(dept)}
          currentCode={tableCode}
          onClose={() => setItemXferOpen(false)}
          onDone={(_fromCode, to) => {
            onMessage(`Items transferred to ${to.code}`);
            goMainBilling();
          }}
          onMessage={onMessage}
        />
      )}
      {pickOpen && (
        <PrepareTablePick
          title={pickOpen === "settle" ? "Settlement" : "Prepare Bill"}
          tables={pickOpen === "settle" ? settleTables : runningForBill}
          onPick={(t) => void (pickOpen === "settle" ? openSettleForTable(t) : openBillForTable(t))}
          onClose={() => setPickOpen(null)}
        />
      )}
      {billOrder && (
        <PrepareBillDialog
          orderId={billOrder.orderId}
          table={billOrder.table}
          outlet={deptOutlet(dept)}
          waiter={waiter}
          guest={guest}
          mobile={mobile}
          onClose={() => setBillOrder(null)}
          onPrinted={(inv) => {
            onInvoice(inv);
            setBillOrder(null);
            setOrderId(null);
            setDetail(null);
            setTableId("");
            setTableCode("");
            onRefresh();
            onMessage("Bill printed");
          }}
          onMessage={onMessage}
        />
      )}
      {settleInv && (
        <SettleDialog
          invoiceId={settleInv.invoiceId}
          table={settleInv.table}
          outlet={deptOutlet(dept)}
          cardNo={cardNo}
          onClose={() => setSettleInv(null)}
          onDone={() => {
            setSettleInv(null);
            setOrderId(null);
            setDetail(null);
            setTableId("");
            setTableCode("");
            onRefresh();
            onMessage("Settled");
          }}
          onMessage={onMessage}
        />
      )}
      {itemMasterOpen && (
        <ItemMasterDialog
          onClose={() => setItemMasterOpen(false)}
          onSaved={() => onRefresh()}
        />
      )}
    </div>
  );
}

function LoginForm({ actor, onLogin, terminalId }: { actor: Actor | null; onLogin: (a: Actor) => void; terminalId: string }) {
  const [username, setUsername] = useState("cashier");
  const [pin, setPin] = useState("2222");
  async function submit() {
    onLogin(await api.post("/api/auth/login", { username, pin, terminalId }));
  }
  return (
    <form className="login-dlg outset" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>User Login</h2>
      <label>User</label>
      <select className="win" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus>
        <option value="owner">owner</option>
        <option value="manager">manager</option>
        <option value="cashier">cashier</option>
        <option value="waiter">waiter</option>
        <option value="kitchen">kitchen</option>
        <option value="bar">bar</option>
      </select>
      <label style={{ marginTop: 8, display: "block" }}>PIN</label>
      <input className="win" value={pin} onChange={(e) => setPin(e.target.value)} />
      <button type="submit" className="fn wide" style={{ marginTop: 12 }}>
        {actor ? "Switch user" : "Login"}
      </button>
      <p className="meta">{actor?.staffName} · {actor?.role}</p>
    </form>
  );
}

function Tables({ tables, onOpen, onRefresh }: { tables: Table[]; onOpen: (t: Table) => void; onRefresh: () => void; onCheckin: () => void }) {
  const floors = useMemo(() => [...new Set(tables.map((t) => t.floor_name))], [tables]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  return (
    <div>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <select className="win" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 120 }}>
          <option value="">From</option>
          {tables.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
        </select>
        <select className="win" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 120 }}>
          <option value="">To</option>
          {tables.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
        </select>
        <button className="fn" onClick={async () => { await api.post("/api/tables/transfer", { fromTableId: from, toTableId: to }); onRefresh(); }}>T. Transfer</button>
        <button className="fn" onClick={async () => { await api.post("/api/tables/merge", { sourceTableId: from, targetTableId: to }); onRefresh(); }}>Merge</button>
      </div>
      {floors.map((floor) => (
        <section key={floor} style={{ marginBottom: 12 }}>
          <b>{floor}</b>
          <div className="grid table-grid" style={{ marginTop: 6 }}>
            {tables.filter((t) => t.floor_name === floor).map((t) => (
              <button key={t.id} className={`table-tile ${t.status}`} onClick={() => onOpen(t)}>
                <div className="code">{t.code}</div>
                <div className="status">{t.status.replace("_", " ")}</div>
                {!!t.running_total && <div>{formatINR(t.running_total)}</div>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CardSearch({ onPick }: { onPick: (c: Card) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Card[]>([]);
  return (
    <div>
      <input className="win" placeholder="Card / mobile / name" value={q} onChange={async (e) => {
        setQ(e.target.value);
        if (e.target.value.length >= 2) setRows(await api.get(`/api/cards?q=${encodeURIComponent(e.target.value)}`));
      }} />
      <table className="data">
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} onClick={() => onPick(c)}>
              <td>{c.card_number}</td><td>{c.customer_name}</td><td>{c.mobile}</td>
              <td>{formatINR(c.paid_balance + c.bonus_balance)}</td><td>{c.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RechargeScreen() {
  const [card, setCard] = useState<Card | null>(null);
  const [amount, setAmount] = useState(500000);
  const [mode, setMode] = useState<PaymentMode>("CASH");
  const [result, setResult] = useState("");
  return (
    <div className="grid two">
      <div><CardSearch onPick={setCard} /></div>
      <div>
        {card ? (
          <>
            <p>{card.customer_name} · {card.card_number} · {formatINR(card.paid_balance + card.bonus_balance)}</p>
            <div className="btn-row">{[500, 1000, 2000, 5000].map((p) => <button key={p} className="fn" onClick={() => setAmount(p * 100)}>₹{p}</button>)}</div>
            <input className="win" type="number" value={amount / 100} onChange={(e) => setAmount(Math.round(Number(e.target.value) * 100))} />
            <div className="btn-row">{(["CASH", "UPI", "CARD", "OTHER"] as PaymentMode[]).map((m) => <button key={m} className="fn" onClick={() => setMode(m)}>{m}</button>)}</div>
            <button className="fn wide" onClick={async () => {
              const r = await api.post<any>(`/api/cards/${card.id}/recharge`, { amount, paymentMode: mode, printReceipt: true });
              setCard(r.card);
              setResult(`New ${formatINR(r.card.paid_balance + r.card.bonus_balance)}`);
            }}>Recharge</button>
            {result && <p className="ok">{result}</p>}
          </>
        ) : <p className="meta">Search a card.</p>}
      </div>
    </div>
  );
}

function BalanceScreen() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<any>(null);
  return (
    <div>
      <input className="win" autoFocus placeholder="Scan card / mobile / name" value={q} onChange={async (e) => {
        setQ(e.target.value);
        if (e.target.value.length >= 2) setData(await api.get(`/api/cards/balance/check?q=${encodeURIComponent(e.target.value)}`));
      }} />
      {data && (
        <div style={{ marginTop: 10 }}>
          <p>{data.card.customer_name} · {data.card.card_number} · {data.card.status}</p>
          <p><b>{formatINR(data.balances.usable)}</b></p>
        </div>
      )}
    </div>
  );
}

function CardsScreen() {
  const [cards, setCards] = useState<Card[]>([]);
  const [form, setForm] = useState({ name: "", mobile: "", cardNumber: "", cardUid: "", cardTypeCode: "MEMBER" });
  useEffect(() => { api.get<Card[]>("/api/cards").then(setCards); }, []);
  return (
    <div className="grid two">
      <div>
        <input className="win" placeholder="Member name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="win" placeholder="Mobile" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} style={{ marginTop: 6 }} />
        <input className="win" placeholder="Card number" value={form.cardNumber} onChange={(e) => setForm({ ...form, cardNumber: e.target.value })} style={{ marginTop: 6 }} />
        <input className="win" placeholder="RFID UID" value={form.cardUid} onChange={(e) => setForm({ ...form, cardUid: e.target.value })} style={{ marginTop: 6 }} />
        <select className="win" value={form.cardTypeCode} onChange={(e) => setForm({ ...form, cardTypeCode: e.target.value })} style={{ marginTop: 6 }}>
          <option>REGULAR</option><option>MEMBER</option><option>VIP</option><option>CORPORATE</option>
        </select>
        <button className="fn wide" style={{ marginTop: 8 }} onClick={async () => {
          await api.post("/api/cards/issue", { customer: { name: form.name, mobile: form.mobile }, cardNumber: form.cardNumber, cardUid: form.cardUid || undefined, cardTypeCode: form.cardTypeCode });
          setCards(await api.get("/api/cards"));
        }}>Issue + Activate</button>
      </div>
      <table className="data">
        <thead><tr><th>Card</th><th>Member</th><th>Balance</th><th>Status</th><th /></tr></thead>
        <tbody>
          {cards.map((c) => (
            <tr key={c.id}>
              <td>{c.card_number}</td><td>{c.customer_name}</td>
              <td>{formatINR(c.paid_balance + c.bonus_balance)}</td><td>{c.status}</td>
              <td>
                <button className="fn" onClick={() => api.post(`/api/cards/${c.id}/block`, { reason: "Lost" }).then(async () => setCards(await api.get("/api/cards")))}>Block</button>
                <button className="fn" onClick={() => api.post(`/api/cards/${c.id}/unblock`, { reason: "Customer request" }).then(async () => setCards(await api.get("/api/cards")))}>Unblock</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SwapScreen() {
  const [oldCard, setOldCard] = useState<Card | null>(null);
  const [number, setNumber] = useState("");
  const [reason, setReason] = useState("Damaged");
  const [out, setOut] = useState("");
  return (
    <div>
      <CardSearch onPick={setOldCard} />
      {oldCard && (
        <>
          <p>Old {oldCard.card_number} · {formatINR(oldCard.paid_balance + oldCard.bonus_balance)}</p>
          <input className="win" placeholder="New card number" value={number} onChange={(e) => setNumber(e.target.value)} />
          <select className="win" value={reason} onChange={(e) => setReason(e.target.value)} style={{ marginTop: 6 }}>
            <option>Damaged</option><option>Lost</option><option>Customer request</option>
          </select>
          <button className="fn wide" style={{ marginTop: 8 }} onClick={async () => {
            const r = await api.post<any>("/api/cards/swap", { oldCardId: oldCard.id, newCardNumber: number, reason });
            setOut(`Transferred ${formatINR(r.transferred.usable)} to ${r.newCard.card_number}`);
          }}>Swap</button>
        </>
      )}
      {out && <p className="ok">{out}</p>}
    </div>
  );
}

function LedgerScreen() {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  async function load(cardId?: string) {
    const qs = new URLSearchParams();
    if (cardId) qs.set("cardId", cardId);
    if (type) qs.set("type", type);
    setRows(await api.get(`/api/ledger?${qs}`));
  }
  return (
    <div>
      <CardSearch onPick={(c) => load(c.id)} />
      <select className="win" value={type} onChange={(e) => setType(e.target.value)} style={{ width: 180, marginTop: 6 }}>
        <option value="">All types</option>
        {["RECHARGE","PURCHASE","REFUND","TRANSFER","CARD_SWAP","ADJUSTMENT","BONUS","EXPIRY","REVERSAL"].map((t) => <option key={t}>{t}</option>)}
      </select>
      <input className="win" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" style={{ marginTop: 6 }} />
      <table className="data">
        <thead><tr><th>Txn</th><th>Type</th><th>Opening</th><th>Credit</th><th>Debit</th><th>Closing</th></tr></thead>
        <tbody>
          {rows.filter((r) => !q || JSON.stringify(r).includes(q)).map((r) => {
            const credit = r.direction === "CREDIT" ? r.paid_amount + r.bonus_amount : 0;
            const debit = r.direction === "DEBIT" ? r.paid_amount + r.bonus_amount : 0;
            return (
              <tr key={r.id}>
                <td>{r.id}</td><td>{r.type}</td>
                <td>{formatINR(r.previous_paid + r.previous_bonus)}</td>
                <td>{credit ? formatINR(credit) : "—"}</td>
                <td>{debit ? formatINR(debit) : "—"}</td>
                <td>{formatINR(r.new_paid + r.new_bonus)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KotBoard({ station }: { station?: "KITCHEN" | "BAR" }) {
  const [kots, setKots] = useState<any[]>([]);
  async function load() {
    setKots(await api.get(`/api/kots${station ? `?station=${station}` : ""}`));
  }
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [station]);
  const cols = ["SENT", "ACCEPTED", "PREPARING", "READY", "SERVED"];
  const next: Record<string, string> = { SENT: "ACCEPTED", ACCEPTED: "PREPARING", PREPARING: "READY", READY: "SERVED" };
  return (
    <div className="kot-board">
      {cols.map((col) => (
        <div key={col} className="kot-col">
          <b>{col === "SENT" ? "NEW ORDERS" : col}</b>
          {kots.filter((k) => k.status === col || (col === "SENT" && k.status === "NEW")).map((k) => (
            <div key={k.id} className="kot-ticket">
              <b>{k.kot_number}</b>
              <div className="meta">TABLE {k.table_code} · {k.station}</div>
              {k.reprint_count > 0 && <div className="reprint-mark">*** REPRINT ***</div>}
              <ul>{k.items?.map((i: any) => <li key={i.id}>{i.qty} × {i.name}</li>)}</ul>
              {next[k.status] && <button className="fn wide" onClick={() => api.post(`/api/kots/${k.id}/status`, { status: next[k.status] }).then(load)}>{next[k.status]}</button>}
              <button className="fn wide" onClick={() => api.post(`/api/kots/${k.id}/reprint`).then(load)}>Reprint</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Orders({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>("/api/orders").then(setRows); }, []);
  return (
    <table className="data">
      <thead><tr><th>Order</th><th>Table</th><th>Status</th><th>Total</th></tr></thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.id} onClick={() => onOpen(o.id)}>
            <td>{o.order_number}</td><td>{o.table_code}</td><td>{o.status}</td><td>{formatINR(o.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CustomersScreen() {
  const [rows, setRows] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  useEffect(() => { api.get<any[]>("/api/customers").then(setRows); }, []);
  return (
    <div className="grid two">
      <div>
        <input className="win" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="win" placeholder="Mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} style={{ marginTop: 6 }} />
        <button className="fn wide" style={{ marginTop: 6 }} onClick={async () => { await api.post("/api/customers", { name, mobile }); setRows(await api.get("/api/customers")); }}>Save</button>
      </div>
      <table className="data"><tbody>{rows.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.mobile}</td></tr>)}</tbody></table>
    </div>
  );
}

function ProductsScreen({ products }: { products: Product[] }) {
  return <table className="data"><thead><tr><th>SKU</th><th>Name</th><th>Station</th><th>Price</th></tr></thead><tbody>{products.map((p) => <tr key={p.id}><td>{p.sku}</td><td>{p.name}</td><td>{p.station}</td><td>{formatINR(p.base_price)}</td></tr>)}</tbody></table>;
}

function InventoryScreen() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>("/api/inventory").then(setRows); }, []);
  return <table className="data"><thead><tr><th>Product</th><th>Station</th><th>Qty</th></tr></thead><tbody>{rows.map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.station}</td><td>{r.quantity}</td></tr>)}</tbody></table>;
}

function PurchaseScreen({ products }: { products: Product[] }) {
  const [supplier, setSupplier] = useState("");
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [qty, setQty] = useState(10);
  return (
    <div style={{ maxWidth: 420 }}>
      <input className="win" placeholder="Supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
      <select className="win" value={productId} onChange={(e) => setProductId(e.target.value)} style={{ marginTop: 6 }}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <input className="win" type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} style={{ marginTop: 6 }} />
      <button className="fn wide" style={{ marginTop: 6 }} onClick={() => api.post("/api/purchases", { supplier, items: [{ productId, qty, cost: 10000 }] })}>Receive</button>
    </div>
  );
}

function ExpensesScreen() {
  const [category, setCategory] = useState("Utilities");
  const [amount, setAmount] = useState(0);
  return (
    <div style={{ maxWidth: 360 }}>
      <input className="win" value={category} onChange={(e) => setCategory(e.target.value)} />
      <input className="win" type="number" placeholder="₹" onChange={(e) => setAmount(Math.round(Number(e.target.value) * 100))} style={{ marginTop: 6 }} />
      <button className="fn wide" style={{ marginTop: 6 }} onClick={() => api.post("/api/expenses", { category, amount })}>Add expense</button>
    </div>
  );
}

function ReportsScreen() {
  const [dash, setDash] = useState<any>(null);
  const [rec, setRec] = useState<any>(null);
  useEffect(() => {
    api.get("/api/reports/dashboard").then(setDash).catch((e) => setDash({ error: e.message }));
    api.get("/api/reports/reconciliation").then(setRec).catch(() => null);
  }, []);
  if (!dash) return <p>Loading…</p>;
  if (dash.error) return <p className="flash">{dash.error}</p>;
  return (
    <div>
      <p>Today recharge {formatINR(dash.todayRecharge)} · Card sales {formatINR(dash.cardSales)} · Outstanding {formatINR(dash.outstandingTotal)}</p>
      {rec && (
        <p>Opening {formatINR(rec.openingLiability)} + Recharge {formatINR(rec.recharges)} − Purchases {formatINR(rec.purchases)} = Expected {formatINR(rec.expectedClosing)} Diff {formatINR(rec.difference)}</p>
      )}
      <button className="fn" onClick={() => api.post("/api/reports/day-close", {})}>Day Close</button>
    </div>
  );
}

function StaffScreen() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>("/api/staff").then(setRows); }, []);
  return <table className="data"><thead><tr><th>Name</th><th>User</th><th>Role</th></tr></thead><tbody>{rows.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.username}</td><td>{s.role}</td></tr>)}</tbody></table>;
}

function SettingsScreen({ settings, onSaved }: { settings: Record<string, string>; onSaved: () => void }) {
  const [form, setForm] = useState(settings);
  return (
    <div style={{ maxWidth: 480 }}>
      {Object.entries(form).map(([k, v]) => (
        <label key={k} style={{ display: "block", marginBottom: 8 }}>
          {k}
          <input className="win" value={v} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
        </label>
      ))}
      <button className="fn" onClick={async () => { await api.put("/api/settings", form); onSaved(); }}>Save</button>
    </div>
  );
}

function HistoryScreen({ invoice }: { invoice: Invoice | null }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>("/api/invoices").then(setRows); }, []);
  return (
    <div>
      {invoice && <p className="ok">{invoice.invoice_number} · {formatINR(invoice.grand_total)}</p>}
      <table className="data">
        <thead><tr><th>Invoice</th><th>Table</th><th>Total</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.invoice_number}</td><td>{r.table_code}</td><td>{formatINR(r.grand_total)}</td><td>{r.status}</td>
              <td><button className="fn" onClick={() => api.post(`/api/invoices/${r.id}/print`)}>Reprint</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CheckinScreen({ tables, onDone }: { tables: Table[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [cardQ, setCardQ] = useState("");
  const [tableId, setTableId] = useState(tables.find((t) => t.status === "AVAILABLE")?.id ?? "");
  return (
    <div style={{ maxWidth: 420 }}>
      <input className="win" placeholder="Guest name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="win" placeholder="Mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} style={{ marginTop: 6 }} />
      <input className="win" placeholder="Member card" value={cardQ} onChange={(e) => setCardQ(e.target.value)} style={{ marginTop: 6 }} />
      <select className="win" value={tableId} onChange={(e) => setTableId(e.target.value)} style={{ marginTop: 6 }}>
        {tables.filter((t) => t.status === "AVAILABLE").map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
      </select>
      <button className="fn wide" style={{ marginTop: 8 }} onClick={async () => {
        const customer = await api.post<any>("/api/customers", { name, mobile });
        const found = cardQ ? await api.get<Card[]>(`/api/cards?q=${encodeURIComponent(cardQ)}`) : [];
        await api.post(`/api/tables/${tableId}/checkin`, { customerId: customer.id, cardId: found[0]?.id });
        onDone();
      }}>Check in</button>
    </div>
  );
}
