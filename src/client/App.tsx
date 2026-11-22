import { formatUiLabel } from "./formatUiLabel";
import { Component, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { ignoreRepeatedPrintKey, reprintKot } from "./printActions";
import { api, ApiError } from "./api";
import { formatINR } from "../shared/money";
import { formatTableNo } from "../shared/tableLabel";
import type { Actor, NavView, PaymentMode } from "../shared/types";
import { ADVANCE_OUTLETS, isAdminActor, isAdvanceOutlet, isBarOrderOnly, outletRight, rightOn, viewRight } from "../shared/userRights";
import { AlertBox, CapBtns, ConfirmAsk, ItemNotesDialog, ItemTransferDialog, PrepareBillDialog, PrepareTablePick, SettleDialog, TransferDialog } from "./BillDialogs";
import { armReplaceOnFocus, blockLetterInsert, blockLetters, cardNoDigits, cardNoReady, moveFormFocus, replaceOnFirstKey, stayOnCard } from "./formNav";
import { itemMatchScore } from "../shared/itemSearch";
import { ItemMasterDialog } from "./ItemMaster";
import { ComplimentaryMasterDialog } from "./ComplimentaryMaster";
import { LoginGate } from "./Login";
import { UserMaster } from "./UserMaster";

const ReportHost = lazy(() => import("./Reports").then((module) => ({ default: module.ReportHost })));

class ReportCrashBoundary extends Component<{ children: ReactNode; onRecover: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Report page crashed; returning to billing", error, info.componentStack);
    window.setTimeout(this.props.onRecover, 0);
  }

  render() {
    if (this.state.failed) return <div role="status" style={{ padding: 16 }}>Returning to the main screen…</div>;
    return this.props.children;
  }
}

function StaffMark({ name }: { name: string }) {
  const label = name.trim();
  if (!label) return null;
  const safe = label.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch] ?? ch
  ));
  const width = Math.max(260, label.length * 18 + 90);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="150"><text x="16" y="88" fill="#9a9a9a" fill-opacity="0.28" font-family="Tahoma,sans-serif" font-size="22" font-weight="700" transform="rotate(-28 ${width / 2} 75)">${safe}</text></svg>`;
  return (
    <div
      className="staff-mark"
      aria-hidden="true"
      style={{ backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")` }}
    />
  );
}
type Table = {
  id: string; code: string; name: string; status: string; floor_name: string; floor_id: string;
  current_session_id: string | null; customer_name?: string; card_number?: string; running_total?: number; net_total?: number;
  session_opened_at?: string; outlet?: string; has_running_order?: boolean;
};

type Dept = "CLUB" | "RESTAURANT" | "NC" | "BAR";
const DEPT_ORDER: Dept[] = ["CLUB", "RESTAURANT", "NC", "BAR"];

function deptOutlet(d: Dept) {
  return d === "CLUB" ? "THE BOSS CLUB" : d;
}
type Product = {
  id: string; name: string; station: string; base_price: number; sku: string;
  tax_rate?: number;
  sales_group?: string;
  item_group?: string;
  dept_rates?: Record<string, { rate: number; enabled: number; inclusive?: number }>;
};

const TAB_ITEM_GROUPS: Record<Dept, string[] | null> = {
  BAR: ["BAR", "BEVERAGE"],
  RESTAURANT: ["FOOD"],
  CLUB: ["EV CAFE", "EV FOOD", "SPL", "SPL1"],
  NC: null,
};

/** IBS inclusive dept rate → exclusive punch price (90 @ 18% → 76.27). */
function exclusiveRate(paise: number, taxRate: number) {
  const tax = Number(taxRate) || 0;
  if (tax <= 0) return Math.round(paise);
  return Math.round(paise / (1 + tax / 100));
}

/** Sales-group tax. A group name containing FREE is 0%. */
function salesTaxPercent(salesGroup?: string, productTax?: number) {
  const upper = (salesGroup || "").trim().toUpperCase();
  if (!upper) return Number(productTax) || 0;
  if (upper.includes("FREE")) return 0;
  const match = upper.match(/(\d+(?:\.\d+)?)\s*%/);
  if (match) return Number(match[1]);
  return Number(productTax) || 0;
}

function lineNetPaise(qty: number, unitPrice: number, taxRate: number) {
  const amount = qty * unitPrice;
  return amount + Math.round((amount * taxRate) / 100);
}

function priceForOutlet(p: Product, outletName: string) {
  const row = p.dept_rates?.[outletName];
  if (!row || Number(row.enabled) === 0) return p.base_price;
  const raw = Number(row.rate) > 0 ? Number(row.rate) : p.base_price;
  if (Number(row.inclusive) !== 0) return exclusiveRate(raw, Number(p.tax_rate) || 0);
  return raw;
}

function onThisTab(p: Product, dept: Dept) {
  const outletName = deptOutlet(dept);
  const rate = p.dept_rates?.[outletName];
  // Imported IBS rates win: FOOD items with BAR enabled must show on BAR, etc.
  if (rate) return Number(rate.enabled) !== 0;

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

type AppView = NavView | "login" | "billing" | "user-master";
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
    id: "master",
    label: "Master",
    items: [
      { label: "User", view: "user-master" },
    ],
  },
  {
    id: "fnb",
    label: "F&B",
    items: [
      { label: "Bar", children: DEPT_LEAVES.map((x) => ({ ...x, outlet: "BAR" })) },
      { label: "NC", children: DEPT_LEAVES.map((x) => ({ ...x, outlet: "NC" })) },
      { label: "Restaurant", children: DEPT_LEAVES.map((x) => ({ ...x, outlet: "RESTAURANT" })) },
      { label: "The Boss Club", children: DEPT_LEAVES.map((x) => ({ ...x, outlet: "THE BOSS CLUB" })) },
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
      { label: "F&B", children: [
        { label: "GST Report", view: "gst-report" },
        { label: "Point of Sale", view: "point-of-sales" },
        { label: "Item Wise Sales", view: "item-wise-sale" },
        { label: "Item Wise Group Sales Report", view: "item-wise-group" },
        { label: "Item Wise Sales Detail", view: "item-wise-detail" },
        { label: "Item Transfer Report", view: "item-transfer-report" },
        { label: "Table Transfer Report", view: "table-transfer-report" },
        { label: "KOT Cancellation Report", view: "kot-cancellation-report" },
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
      { label: "Card Settlement Report", view: "card-settlement-report" },
    ],
  },
];

function visibleMenus(rights: Record<string, boolean> | null | undefined) {
  return MENUS.map((menu) => {
    const items = menu.items.flatMap((item) => {
      if (item.children) {
        const children = item.children.filter((child) =>
          rightOn(rights, viewRight(child.view, child.outlet) ?? "") &&
          (!child.outlet || rightOn(rights, outletRight(child.outlet))),
        );
        return children.length ? [{ ...item, children }] : [];
      }
      return rightOn(rights, viewRight(item.view ?? "", item.outlet) ?? "") ? [item] : [];
    });
    return { ...menu, items };
  }).filter((menu) => menu.items.length > 0);
}

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

function businessStartMs(at = new Date()) {
  const d = new Date(at);
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  d.setHours(6, 0, 0, 0);
  return d.getTime();
}

const DROP_ROWS = 12;
function visiblePicks<T>(list: T[], pick: number) {
  if (list.length <= DROP_ROWS) return list.map((p, i) => ({ p, i }));
  const start = Math.min(Math.max(0, pick - 2), list.length - DROP_ROWS);
  return list.slice(start, start + DROP_ROWS).map((p, n) => ({ p, i: start + n }));
}

function WinClock() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.value = formatWinDate(new Date());
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <input ref={ref} className="win" readOnly tabIndex={-1} defaultValue={formatWinDate(new Date())} />;
}

export function App() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [view, setView] = useState<AppView>("billing");
  const [bootstrap, setBootstrap] = useState<any>(null);
  const [error, setError] = useState("");
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [menu, setMenu] = useState<string | null>(null);
  const [menuLeft, setMenuLeft] = useState(4);
  const [sub, setSub] = useState<string | null>(null);
  const [outlet, setOutlet] = useState("BAR");
  const outletRef = useRef(outlet);
  const stepDeptRef = useRef<((dir: -1 | 1) => void) | null>(null);
  outletRef.current = outlet;
  const [invoice, setInvoice] = useState<any>(null);
  const [alertText, setAlertText] = useState("");
  const alertAfterRef = useRef<(() => void) | null>(null);

  const barOnly = isBarOrderOnly(actor?.rights);
  const advance = actor?.userGroup === "ADVANCE";
  const cashier = actor?.userGroup === "CASHIER";

  async function refresh() {
    const data = await api.get<any>("/api/bootstrap");
    setBootstrap(data);
  }

  async function logout() {
    try { await api.post("/api/auth/logout"); } catch { /* lock the screen anyway */ }
    setActor(null);
    setSignedIn(false);
    setView("billing");
    setMenu(null);
    setSub(null);
  }

  async function refreshTables() {
    const rows = await api.get<Table[]>("/api/tables");
    setBootstrap((prev: any) => (prev ? { ...prev, tables: rows } : prev));
    return rows;
  }

  useEffect(() => {
    if (!barOnly) return;
    const timer = window.setInterval(() => { void refreshTables().catch(() => null); }, 5000);
    return () => window.clearInterval(timer);
  }, [barOnly]);

  useEffect(() => {
    const request = new AbortController();
    const timeout = setTimeout(() => {
      setError("The POS server took too long to respond.");
      request.abort();
    }, 10000);
    void api.get<any>("/api/bootstrap", request.signal).then((data) => {
      if (!request.signal.aborted) setBootstrap(data);
    }).catch(() => {
      if (!request.signal.aborted) setError("Could not connect to the POS server.");
    }).finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      request.abort();
    };
  }, [bootstrapAttempt]);

  function notify(m: string, after?: () => void) {
    alertAfterRef.current = after ?? null;
    setAlertText(m.trim());
  }

  function closeAlert() {
    setAlertText("");
    const after = alertAfterRef.current;
    alertAfterRef.current = null;
    if (after) window.requestAnimationFrame(() => window.requestAnimationFrame(after));
  }

  function go(next: AppView, nextOutlet?: string) {
    const permission = viewRight(next, nextOutlet);
    if (permission?.startsWith("report.") && !rightOn(actor?.rights, permission)) return;
    if (barOnly && ((nextOutlet && nextOutlet !== "BAR") || !["billing", "kot-report", "bill-report", "settlement-report"].includes(next))) return;
    if (cashier && next === "user-master") return;
    if (advance && ((nextOutlet && !isAdvanceOutlet(nextOutlet)) || !DEPT_LEAVES.some((leaf) => leaf.view === next))) return;
    setView(next);
    if (nextOutlet) setOutlet(nextOutlet);
    setMenu(null);
    setSub(null);
  }

  useEffect(() => {
    const order = ["THE BOSS CLUB", "RESTAURANT", "NC", "BAR"];
    (window as Window & { __bossStepDept?: (dir: number) => void }).__bossStepDept = (dir) => {
      if (barOnly) return;
      const step = dir < 0 ? -1 : 1;
      if (stepDeptRef.current) {
        stepDeptRef.current(step);
        return;
      }
      const now = Date.now();
      const mark = window as Window & { __bossStepAt?: number };
      if (now - (mark.__bossStepAt || 0) < 50) return;
      mark.__bossStepAt = now;
      const i = Math.max(0, order.indexOf(outletRef.current));
      go("billing", order[(i + step + order.length) % order.length]);
    };
    return () => {
      delete (window as Window & { __bossStepDept?: (dir: number) => void }).__bossStepDept;
    };
  });

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (moveFormFocus(e)) return;
      blockLetters(e);
      if (e.defaultPrevented) return;
      replaceOnFirstKey(e);
    }
    window.addEventListener("keydown", keys, true);
    document.addEventListener("beforeinput", blockLetterInsert, true);
    document.addEventListener("focusin", armReplaceOnFocus);
    return () => {
      window.removeEventListener("keydown", keys, true);
      document.removeEventListener("beforeinput", blockLetterInsert, true);
      document.removeEventListener("focusin", armReplaceOnFocus);
    };
  }, []);

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Restaurant Bill / settlement dialogs own Escape (back to report first)
      if (document.querySelector(".bill-dlg, .settle-dlg, .su-dlg, .cs-dlg, .confirm-dlg, .confirm-overlay, .alert-dlg, .kot-view")) return;
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
        <div className="login-dlg outset">
          {error ? (
            <>
              <p role="alert">{error}</p>
              <button type="button" className="fn" onClick={() => {
                setError("");
                setBootstrapAttempt((attempt) => attempt + 1);
              }}>Retry</button>
            </>
          ) : <span role="status">Loading…</span>}
        </div>
      </div>
    );
  }

  const outletMenuItems = (outlets: readonly string[], operator = false): MenuNode[] => outlets.map((outlet) => ({
    label: outlet,
    children: DEPT_LEAVES.filter((leaf) => (!operator || leaf.view !== "history") &&
      rightOn(actor?.rights, viewRight(leaf.view, outlet) ?? "")).map((leaf) => ({ ...leaf, outlet })),
  }));
  const menus: typeof MENUS = barOnly ? [{
    id: "fnb",
    label: "F n B",
    items: outletMenuItems(["BAR"], true),
  }] : advance ? [{
    id: "fnb",
    label: "F n B",
    items: outletMenuItems(ADVANCE_OUTLETS),
  }] : visibleMenus(signedIn ? actor?.rights : null);
  return (
    <div className="winapp" onClick={() => { setMenu(null); setSub(null); }}>
      <nav className="menubar" onClick={(e) => e.stopPropagation()}>
        {menus.map((m) => (
          <button
            key={m.id}
            className={menu === m.id ? "open" : ""}
            onClick={(e) => {
              setMenuLeft(e.currentTarget.offsetLeft);
              setMenu(menu === m.id ? null : m.id);
              setSub(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                setMenuLeft(e.currentTarget.offsetLeft);
                setMenu(m.id);
                setSub(null);
              }
            }}
          >
            {m.label}
          </button>
        ))}
        {signedIn && (barOnly || rightOn(actor?.rights, "logout")) && (
          <button type="button" onClick={() => { void logout(); }}>Logout</button>
        )}
        {menu && (
          <div className="menu-flyout" style={{ left: menuLeft }}>
            {menus.find((m) => m.id === menu)?.items.map((item) => (
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

      {signedIn && view === "billing" && (
        <BillingScreen
          tables={bootstrap.tables}
          products={bootstrap.products}
          outlet={outlet}
          onRefresh={refreshTables}
          onCatalog={refresh}
          onInvoice={setInvoice}
          onMessage={notify}
          onOpenView={go}
          onRegisterStep={(fn) => { stepDeptRef.current = fn; }}
          access={{
            item: rightOn(actor?.rights, "master.item"),
            comp: actor?.allowComplementary !== false,
            table: actor?.tableTransfer !== false,
            itemXfer: actor?.itemTransfer !== false,
          }}
          barOnly={barOnly}
          advance={advance}
          cashier={cashier}
          canOpenReport={(report) => rightOn(actor?.rights, viewRight(report) ?? "")}
          allowDept={(d) => barOnly ? d === "BAR" : advance ? isAdvanceOutlet(deptOutlet(d)) : rightOn(actor?.rights, outletRight(deptOutlet(d)))}
        />
      )}

      {signedIn && view === "user-master" && (
        <div className="workarea plain">
          <UserMaster selfId={actor?.staffId ?? ""} allowMasterPinChange={isAdminActor(actor)} onExit={() => go("billing")} />
        </div>
      )}

      {signedIn && view !== "billing" && view !== "login" && view !== "user-master" && (
        <div className={`workarea ${["card-block","advance-booking","booking-report","item-wise-sale","item-wise-group","settlement-report","card-settlement-report","kot-report","bill-report","history","item-combine-stock","outlet-stock","time-sale","tax-wise"].includes(view) ? "plain" : ""}`}>
          {view === "kot" && <div className="rpt-page plain" style={{ padding: 8 }}><KotBoard /></div>}
          {view === "kitchen" && <div className="rpt-page plain" style={{ padding: 8 }}><KotBoard station="KITCHEN" /></div>}
          {view === "bar" && <div className="rpt-page plain" style={{ padding: 8 }}><KotBoard station="BAR" /></div>}
          <ReportCrashBoundary key={view} onRecover={() => go("billing")}>
            <Suspense fallback={<div className="rpt-page" role="status">Loading report…</div>}>
              <ReportHost view={view as NavView} outlet={outlet} advance={advance} cashier={cashier} operator={barOnly} onExit={() => go("billing")} />
            </Suspense>
          </ReportCrashBoundary>
        </div>
      )}

      {!signedIn && (
        <LoginGate
          terminalId={bootstrap.actor.terminalId}
          onLogin={(next) => {
            setActor(next);
            setSignedIn(true);
            go("billing", isBarOrderOnly(next.rights) || next.userGroup === "ADVANCE" ? "BAR" : undefined);
            void refresh().catch(() => null);
          }}
          onExit={() => {
            if (window.bossWindow) void window.bossWindow.close();
            else window.close();
          }}
        />
      )}
      {alertText && <AlertBox message={alertText} onClose={closeAlert} />}
      <StaffMark name={actor?.username ?? actor?.staffName ?? ""} />
    </div>
  );
}

function BillingScreen({ tables, products, outlet, onRefresh, onCatalog, onInvoice, onMessage, onOpenView, onRegisterStep, access, allowDept, barOnly, advance, cashier, canOpenReport }: {
  tables: Table[];
  products: Product[];
  outlet: string;
  onRefresh: () => Promise<Table[]>;
  onCatalog: () => void;
  onInvoice: (inv: any) => void;
  onMessage: (m: string, after?: () => void) => void;
  onOpenView: (v: AppView, nextOutlet?: string) => void;
  onRegisterStep: (fn: ((dir: -1 | 1) => void) | null) => void;
  access?: { item: boolean; comp: boolean; table: boolean; itemXfer: boolean };
  barOnly: boolean;
  advance: boolean;
  cashier: boolean;
  canOpenReport: (view: AppView) => boolean;
  allowDept?: (d: Dept) => boolean;
}) {
  const [tableId, setTableId] = useState("");
  const [tableCode, setTableCode] = useState("");
  const [orderId, setOrderId] = useState<string | null>(null);
  const tableRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLInputElement>(null);
  const clubCardRef = useRef<HTMLInputElement>(null);
  const itemRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const nameLockRef = useRef(false);
  const queryRef = useRef("");
  const remarkRef = useRef<HTMLInputElement>(null);
  const kotBtnRef = useRef<HTMLButtonElement>(null);
  const gridBodyRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  const [detail, setDetail] = useState<any>(null);
  const [dept, setDept] = useState<Dept>(outlet === "THE BOSS CLUB" ? "CLUB" : outlet === "RESTAURANT" ? "RESTAURANT" : outlet === "NC" ? "NC" : "BAR");
  const clubMode = dept === "CLUB";
  const [mobile, setMobile] = useState("");
  const [guest, setGuest] = useState("");
  const [clubCard, setClubCard] = useState("");
  const [clubBalPaise, setClubBalPaise] = useState(0);
  const [checkCard, setCheckCard] = useState("");
  const [checkBal, setCheckBal] = useState("0.00");
  const [sel, setSel] = useState(-1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusEntry, setFocusEntry] = useState(0);
  const [remark, setRemark] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState<"bill" | "settle" | "reopen" | null>(null);
  const [billOrder, setBillOrder] = useState<{ orderId: string; table: Table } | null>(null);
  const [settleInv, setSettleInv] = useState<{ invoiceId: string; table: Table } | null>(null);
  const [settleTables, setSettleTables] = useState<Table[]>([]);
  const [askExit, setAskExit] = useState(false);
  const [xferOpen, setXferOpen] = useState(false);
  const [itemXferOpen, setItemXferOpen] = useState(false);
  const [itemMasterOpen, setItemMasterOpen] = useState(false);
  const [compMasterOpen, setCompMasterOpen] = useState(false);
  const [noteItem, setNoteItem] = useState<OrderItem | null>(null);
  /** Punch grid only — not written to DB until Print KOT. */
  const [draftItems, setDraftItems] = useState<OrderItem[]>([]);
  const [draftEstimate, setDraftEstimate] = useState<{ key: string; total: number | null }>();
  const draftSeq = useRef(0);
  const [waiter, setWaiter] = useState("A");
  const [itemQuery, setItemQuery] = useState("");
  const [typed, setTyped] = useState("");
  const [qtyStr, setQtyStr] = useState("1");
  const [qtyInvalid, setQtyInvalid] = useState(false);
  const [pending, setPending] = useState<Product | null>(null);
  const [nameLocked, setNameLocked] = useState(false);
  nameLockRef.current = nameLocked;
  queryRef.current = itemQuery;
  const [listOpen, setListOpen] = useState(false);
  const [pick, setPick] = useState(0);
  const [itemListSel, setItemListSel] = useState(0);
  const [dropPos, setDropPos] = useState({ top: 0, left: 58 });
  const amt = (n: number) => (n / 100).toFixed(2);

  useEffect(() => {
    if (outlet === "THE BOSS CLUB") setDept("CLUB");
    else if (outlet === "RESTAURANT") setDept("RESTAURANT");
    else if (outlet === "NC") setDept("NC");
    else setDept("BAR");
  }, [outlet]);

  useEffect(() => {
    if (dept === "CLUB") clubCardRef.current?.focus();
    else tableRef.current?.focus();
  }, [dept]);

  const table = tables.find((t) => t.id === tableId);
  const allItems: OrderItem[] = detail?.items ?? [];
  const servedItems: OrderItem[] = allItems.filter((it) => it.kot_id);
  const items: OrderItem[] = draftItems;
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
    const v = typed.trim();
    if (!v) return [];
    return catalog
      .map((p) => ({ p, score: itemMatchScore(p.name, p.sku, v) }))
      .filter((row): row is { p: typeof row.p; score: number } => row.score != null)
      .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name))
      .map((row) => row.p);
  }, [catalog, typed]);

  async function loadOrder(id: string) {
    const d = await api.get<any>(`/api/orders/${id}`);
    setDetail(d);
    return d;
  }

  /** Drop any leftover DB punch lines that were never Print KOTed. */
  async function clearServerUnsent(oid: string) {
    const d = await api.get<any>(`/api/orders/${oid}`);
    const unsent = ((d.items ?? []) as OrderItem[]).filter((it) => !it.kot_id);
    for (const it of unsent) {
      await api.post(`/api/order-items/${it.id}/cancel`, { reason: "ESC" }).catch(() => null);
    }
    if (unsent.length) return loadOrder(oid);
    setDetail(d);
    return d;
  }

  function servedQtyOf(productId: string) {
    return servedItems
      .filter((it) => (it.product_id || "") === productId)
      .reduce((s, it) => s + it.qty, 0);
  }

  function draftQtyOf(productId: string, exceptId?: string | null) {
    return draftItems
      .filter((it) => (it.product_id || "") === productId && it.id !== exceptId)
      .reduce((s, it) => s + it.qty, 0);
  }

  async function selectTable(id: string, code?: string, cardOverride?: string) {
    setOrderId(null);
    setTableId(id);
    if (code) setTableCode(code);
    const t = tables.find((x) => x.id === id);
    const existingCard = (t?.card_number || "").trim();
    const typedCard = (cardOverride ?? (clubMode ? clubCard : "")).trim();
    const clubCardNo = existingCard || (clubMode ? typedCard : "");
    if (clubMode && clubCardNo) setClubCard(cardNoDigits(clubCardNo));
    try {
      if (!t || t.status === "AVAILABLE" || t.status === "RESERVED") {
        await api.post(`/api/tables/${id}/open`, {
          outlet: deptOutlet(dept),
          cardNumber: typedCard || undefined,
        });
      } else if (typedCard && !existingCard) {
        await api.post(`/api/tables/${id}/card`, { cardNumber: typedCard });
      }
      const order = await api.post<any>("/api/orders", { tableId: id });
      setOrderId(order.id);
      setItemListSel(0);
      setDraftItems([]);
      setEditingId(null);
      setPending(null);
      setNameLocked(false);
      setItemQuery("");
      setTyped("");
      setQtyStr("1");
      setListOpen(false);
      setSel(-1);
      await clearServerUnsent(order.id);
      if (t?.customer_name) setGuest(t.customer_name);
      if (clubMode && clubCardNo) void loadCard(cardNoDigits(clubCardNo), true);
      else if (existingCard) setCheckCard(cardNoDigits(existingCard));
      onRefresh();
      focusInput(itemRef.current);
    } catch (e) {
      setOrderId(null);
      onMessage(e instanceof Error ? e.message : "Could not open table");
    }
  }

  function switchDept(next: Dept) {
    if (allowDept && !allowDept(next)) {
      onMessage("Permission denied");
      return;
    }
    if (next === dept) {
      focusDept(next);
      return;
    }
    setDept(next);
    setOrderId(null);
    setDetail(null);
    setDraftItems([]);
    setTableId("");
    setTableCode("");
    setPending(null);
    setEditingId(null);
    setNameLocked(false);
    setItemQuery("");
    setTyped("");
    setQtyStr("1");
    setRemark("");
    setListOpen(false);
    setPick(0);
    setItemListSel(0);
    setSel(-1);
    onOpenView("billing", deptOutlet(next));
    focusDept(next);
  }

  function stepDept(dir: -1 | 1) {
    const now = Date.now();
    const mark = window as Window & { __bossStepAt?: number };
    if (now - (mark.__bossStepAt || 0) < 50) return;
    mark.__bossStepAt = now;
    const i = Math.max(0, DEPT_ORDER.indexOf(dept));
    for (let n = 1; n <= DEPT_ORDER.length; n++) {
      const next = DEPT_ORDER[(i + dir * n + DEPT_ORDER.length) % DEPT_ORDER.length];
      if (allowDept && !allowDept(next)) continue;
      switchDept(next);
      return;
    }
  }

  const registerRef = useRef(onRegisterStep);
  registerRef.current = onRegisterStep;
  useEffect(() => {
    registerRef.current((dir) => {
      if (itemMasterOpen || compMasterOpen || askExit) return;
      stepDept(dir);
    });
  });
  useEffect(() => () => registerRef.current(null), []);

  function focusInput(el: HTMLInputElement | null | undefined) {
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.select();
    });
  }

  function focusClubCard() {
    focusInput(clubCardRef.current);
  }

  function focusTableNo() {
    focusInput(tableRef.current);
  }

  function focusDept(next: Dept) {
    requestAnimationFrame(() => {
      const el = next === "CLUB" ? clubCardRef.current : tableRef.current;
      el?.focus();
      el?.select();
    });
  }

  async function ensureOpenByCode(code: string) {
    const raw = code.trim();
    const out = deptOutlet(dept);
    const known = tables.find((x) => x.code.toLowerCase() === raw.toLowerCase() && (x.outlet || "BAR") === out);
    const cardOnTable = (known?.card_number || "").trim();
    const running = Boolean(known && known.status !== "AVAILABLE");
    if (!raw) {
      // Keep the operator in the table field without interrupting table selection.
      focusTableNo();
      return null;
    }
    if (clubMode && !cardNoReady(clubCard) && !cardOnTable && !running) {
      stayOnCard(clubCardRef.current);
      return null;
    }
    if (clubMode && cardOnTable) setClubCard(cardNoDigits(cardOnTable));
    const current = tables.find((x) => x.id === tableId);
    if (orderId && current && (!barOnly || current.status !== "PAYMENT_PENDING") && current.code.toLowerCase() === raw.toLowerCase() && (current.outlet || "BAR") === out) {
      focusInput(itemRef.current);
      return current;
    }
    try {
      let t = tables.find((x) => x.code.toLowerCase() === raw.toLowerCase() && (x.outlet || "BAR") === out);
      if (!t && barOnly) {
        onMessage("Select an existing Bar table");
        return null;
      }
      if (barOnly && t?.status === "PAYMENT_PENDING") {
        onMessage("Bill already printed");
        return null;
      }
      if (!t) {
        t = await api.post<Table>("/api/tables", { code: raw, name: `Table ${raw}`, outlet: out });
      }
      await selectTable(t.id, t.code, clubMode ? (cardOnTable || clubCard.trim()) : undefined);
      return t;
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not open table");
      return null;
    }
  }

  function taxOf(productId?: string, name?: string) {
    const product = (productId ? products.find((p) => p.id === productId) : undefined)
      ?? products.find((p) => p.name.toUpperCase() === (name || "").toUpperCase());
    return salesTaxPercent(product?.sales_group, product?.tax_rate);
  }

  function netOf(it: { product_id?: string; name: string; qty: number; unit_price: number }) {
    return lineNetPaise(it.qty, it.unit_price, taxOf(it.product_id, it.name));
  }

  async function loadCard(q: string, forClub = clubMode) {
    const v = cardNoDigits(q);
    const setNo = forClub ? setClubCard : setCheckCard;
    setNo(v);
    if (!cardNoReady(v)) {
      if (forClub) setClubBalPaise(0);
      else setCheckBal("0.00");
      stayOnCard(forClub ? clubCardRef.current : cardRef.current);
      return false;
    }
    try {
      const exact = forClub ? "&exact=1" : "";
      const b = await api.get<any>(`/api/cards/balance/check?q=${encodeURIComponent(v)}${exact}`);
      const usable = Number(b.balances?.usable ?? 0);
      if (forClub) setClubBalPaise(usable);
      else setCheckBal(amt(usable));
      if (forClub) {
        if (b.card.customer_name) setGuest(b.card.customer_name);
        if (b.card.mobile && !String(b.card.mobile).startsWith("card-")) setMobile(b.card.mobile);
      }
      return true;
    } catch (e) {
      if (forClub) setClubBalPaise(0);
      else setCheckBal("0.00");
      onMessage(e instanceof Error ? e.message : "Card not found", forClub ? focusClubCard : undefined);
      return false;
    }
  }

  async function enterClubCard(cardNumber: string) {
    const cardInput = clubCardRef.current;
    const stillEnteringCard = () =>
      cardInput === clubCardRef.current && cardInput?.value === cardNumber;
    try {
      const rows = await onRefresh();
      if (!stillEnteringCard()) return;
      const runningTable = rows.find((table) =>
        table.outlet === deptOutlet("CLUB")
        && table.current_session_id
        && table.status !== "AVAILABLE"
        && table.status !== "RESERVED"
        && table.card_number?.trim() === cardNumber,
      );
      setTableCode(runningTable?.code ?? "");
      if (await loadCard(cardNumber, true)
          && stillEnteringCard()
          && cardInput === document.activeElement) {
        focusTableNo();
      }
    } catch (e) {
      if (stillEnteringCard()) {
        onMessage(e instanceof Error ? e.message : "Could not look up running tables", focusClubCard);
      }
    }
  }

  function placeDrop() {
    const body = gridBodyRef.current;
    const entry = (body?.querySelector(".igrid-row.editing") ?? body?.querySelector(".igrid-row.entry")) as HTMLElement | null;
    if (!body || !entry) return;
    const b = body.getBoundingClientRect();
    const r = entry.getBoundingClientRect();
    const top = Math.max(0, r.bottom - b.top - 1);
    setDropPos((prev) => (prev.top === top && prev.left === 58 ? prev : { top, left: 58 }));
  }

  function listForPick() {
    return matches;
  }

  function parseQty(raw: string) {
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n === 0 || (barOnly && n < 0)) return null;
    return n;
  }

  function movePick(delta: number, adopt = false) {
    const list = listForPick();
    if (!list.length) return;
    const cur = Math.min(Math.max(0, pick), list.length - 1);
    const next = Math.min(list.length - 1, Math.max(0, cur + delta));
    const p = list[next];
    setPick(next);
    if (adopt && p) {
      setPending(p);
      setItemQuery(p.name);
      setNameLocked(true);
    } else if (!nameLocked && typed.trim()) {
      setListOpen(true);
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
    movePick(delta, true);
    setSel(items.length);
  }

  function clearEditor() {
    setEditingId(null);
    setPending(null);
    setNameLocked(false);
    setItemQuery("");
    setTyped("");
    setQtyStr("1");
    setListOpen(false);
  }

  function scrollGridRow(row: HTMLElement | null | undefined) {
    const body = gridBodyRef.current;
    if (!body || !row || body.scrollHeight <= body.clientHeight) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (bottom > body.scrollTop + body.clientHeight) body.scrollTop = bottom - body.clientHeight;
  }

  function moveRow(delta: number) {
    const last = items.length;
    const cur = sel < 0 || sel > last ? last : sel;
    const next = Math.min(last, Math.max(0, cur + delta));
    if (next === last) {
      clearEditor();
      setSel(next);
      requestAnimationFrame(() => {
        itemRef.current?.focus();
        scrollGridRow(gridBodyRef.current?.querySelector(".igrid-row.entry") as HTMLElement | null);
      });
      return;
    }
    startEdit(next);
    requestAnimationFrame(() => {
      const row = gridBodyRef.current?.querySelectorAll(".igrid-row:not(.entry)")[next] as HTMLElement | undefined;
      scrollGridRow(row);
    });
  }

  function startEdit(index: number) {
    const it = items[index];
    if (!it) {
      setSel(items.length);
      itemRef.current?.focus();
      return;
    }
    const found = products.find((p) => p.id === it.product_id);
    const product: Product = found
      ? { ...found, base_price: it.unit_price }
      : { id: it.product_id || it.id, name: it.name, station: it.station, base_price: it.unit_price, sku: it.sku || "" };
    setEditingId(it.id);
    setPending(product);
    setItemQuery(it.name);
    setTyped("");
    setNameLocked(true);
    setQtyStr(String(Math.trunc(it.qty) || 1));
    setListOpen(false);
    setPick(0);
    setSel(index);
    focusName();
  }

  function replaceItem(index: number, ch: string) {
    const it = items[index];
    if (!it) return;
    const appending = editingId === it.id && !nameLockRef.current;
    const upper = ch.toUpperCase();
    const next = appending ? `${queryRef.current}${upper}` : upper;
    nameLockRef.current = false;
    queryRef.current = next;
    setEditingId(it.id);
    setPending(null);
    setItemQuery(next);
    setTyped(next);
    setNameLocked(false);
    setQtyStr("1");
    setListOpen(true);
    setPick(0);
    setSel(index);
    requestAnimationFrame(() => {
      const el = itemRef.current;
      if (!el) return;
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    });
  }

  function focusName() {
    requestAnimationFrame(() => {
      const el = itemRef.current;
      if (!el) {
        requestAnimationFrame(() => {
          const again = itemRef.current;
          again?.focus();
          const n = again?.value.length ?? 0;
          again?.setSelectionRange(n, n);
        });
        return;
      }
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    });
  }

  function focusQty() {
    requestAnimationFrame(() => {
      const el = qtyRef.current;
      if (!el) {
        requestAnimationFrame(() => {
          qtyRef.current?.focus();
          qtyRef.current?.select();
        });
        return;
      }
      el.focus();
      el.select();
    });
  }

  function chooseItem(product: Product) {
    setListOpen(false);
    setPending(product);
    setItemQuery(product.name);
    setNameLocked(true);
    setQtyStr("1");
    if (!editingId) setSel(items.length);
    focusQty();
  }

  function mergeDraftLine(prev: OrderItem[], product: Product, n: number, keepNotes = ""): OrderItem[] {
    const notes = keepNotes;
    const same = prev.find(
      (it) => (it.product_id || "") === product.id && (it.notes ?? "") === notes,
    );
    if (same) {
      const nextQty = same.qty + n;
      if (nextQty === 0) return prev.filter((it) => it.id !== same.id);
      return prev.map((it) => (it.id === same.id ? { ...it, qty: nextQty } : it));
    }
    if (n < 0 && notes === "") {
      const any = prev.find((it) => (it.product_id || "") === product.id);
      if (any) {
        const nextQty = any.qty + n;
        if (nextQty === 0) return prev.filter((it) => it.id !== any.id);
        if (nextQty > 0) return prev.map((it) => (it.id === any.id ? { ...it, qty: nextQty } : it));
      }
    }
    draftSeq.current += 1;
    const row: OrderItem = {
      id: `draft-${draftSeq.current}`,
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      qty: n,
      unit_price: product.base_price,
      station: product.station,
      notes: notes || undefined,
    };
    return [...prev, row];
  }

  async function addItem(product: Product, qty = 1, next: "item" | "none" = "item") {
    const payCard = clubMode ? clubCard : checkCard;
    if (clubMode && !cardNoReady(payCard)) {
      stayOnCard(clubCardRef.current);
      return false;
    }
    if (!orderId) {
      // Keep the operator in the table field without interrupting table selection.
      focusTableNo();
      return false;
    }
    const n = Number.isInteger(qty) && qty !== 0 ? qty : parseQty(String(qty)) ?? 1;
    if (barOnly && (n < 0 || table?.status === "PAYMENT_PENDING")) return false;
    const netAfter = draftQtyOf(product.id) + n;
    if (netAfter < 0) {
      const served = servedQtyOf(product.id);
      if (served < -netAfter) {
        onMessage(served <= 0 ? "This item not served on this table!" : "Cannot reduce more than ordered qty");
        return false;
      }
    }
    if (n > 0 && payCard.trim()) {
      try {
        const params = new URLSearchParams({ q: payCard.trim() });
        if (clubMode) params.set("exact", "1");
        const b = await api.get<any>(`/api/cards/balance/check?${params}`);
        const usable = Number(b.balances?.usable ?? 0);
        const line = clubMode
          ? lineNetPaise(n, product.base_price, salesTaxPercent(product.sales_group, product.tax_rate))
          : product.base_price * n;
        const running = (table?.running_total as number)
          || servedItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
          || 0;
        const draftTotal = clubMode
          ? draftItems.reduce((s, i) => s + netOf(i), 0)
          : draftItems.reduce((s, i) => s + i.qty * i.unit_price, 0);
        // Club punches are already off the card, so only the new lines need to fit.
        const need = clubMode ? draftTotal + line : running + draftTotal + line;
        if (usable < need) {
          onMessage(`Insufficient amount  Card balance : ${(usable / 100).toFixed(2)}`);
          return false;
        }
        if (clubMode) setClubBalPaise(usable);
        else setCheckBal(amt(usable));
      } catch (e) {
        onMessage(e instanceof Error ? e.message : "Card not found", clubMode ? focusClubCard : undefined);
        return false;
      }
    }
    const merged = mergeDraftLine(draftItems, product, n);
    setDraftItems(merged);
    setPending(null);
    setNameLocked(false);
    setItemQuery("");
    setTyped("");
    setQtyStr("1");
    setListOpen(false);
    setEditingId(null);
    setSel(merged.length);
    if (next === "item") setFocusEntry((x) => x + 1);
    return true;
  }

  const sendingKot = useRef(false);
  const committingQty = useRef(false);
  const kotEnter = useRef<{ punched: boolean; printed: boolean } | null>(null);

  async function punchQty() {
    if (committingQty.current || sendingKot.current) return;
    committingQty.current = true;
    try {
      await commitQty();
    } finally {
      committingQty.current = false;
    }
  }

  async function commitQty() {
    if (barOnly && table?.status === "PAYMENT_PENDING") return false;
    if (!pending) {
      itemRef.current?.focus();
      return;
    }
    const n = parseQty(qtyStr);
    setQtyInvalid(n == null);
    if (n == null) {
      qtyRef.current?.focus();
      qtyRef.current?.select();
      return false;
    }
    // Minus qty is a reduction punch (Print KOT cancel), never in-place /qty edit
    if (n < 0) {
      const ok = await addItem(pending, n, "none");
      if (ok) {
        setEditingId(null);
        if (!remark.trim()) {
          focusInput(remarkRef.current);
        } else {
          setFocusEntry((x) => x + 1);
          focusInput(itemRef.current);
        }
      }
      return ok;
    }
    if (editingId) {
      const line = items.find((it) => it.id === editingId);
      const sameItem = !line || pending.id === line.product_id || pending.name === line.name;
      if (line && !sameItem) {
        setDraftItems((prev) => {
          draftSeq.current += 1;
          const row: OrderItem = {
            id: `draft-${draftSeq.current}`,
            product_id: pending.id,
            sku: pending.sku,
            name: pending.name,
            qty: n,
            unit_price: pending.base_price,
            station: pending.station,
            notes: line.notes,
          };
          return prev.map((it) => (it.id === editingId ? row : it));
        });
      } else if (line && n !== line.qty) {
        setDraftItems((prev) => prev.map((it) => (it.id === editingId ? { ...it, qty: n } : it)));
      }
      clearEditor();
      setSel(draftItems.length);
      focusInput(itemRef.current);
      return true;
    }
    const ok = await addItem(pending, n, "item");
    if (ok) focusInput(itemRef.current);
    return ok;
  }

  async function printKot() {
    if (sendingKot.current || committingQty.current) return;
    if (barOnly && table?.status === "PAYMENT_PENDING") {
      onMessage("Bill already printed");
      return;
    }
    const id = orderId;
    if (!id) {
      onMessage("No items to print");
      return;
    }
    let toSend = draftItems;
    if (pending) {
      const n = parseQty(qtyStr);
      if (n == null) {
        setQtyInvalid(true);
        qtyRef.current?.focus();
        qtyRef.current?.select();
        return;
      }
      if (n < 0) {
        const netAfter = draftQtyOf(pending.id, editingId) + n;
        const served = servedQtyOf(pending.id);
        if (netAfter < 0 && served < -netAfter) {
          onMessage(served <= 0 ? "This item not served on this table!" : "Cannot reduce more than ordered qty");
          return;
        }
      }
      if (editingId) {
        const line = draftItems.find((it) => it.id === editingId);
        const sameItem = !line || pending.id === line.product_id || pending.name === line.name;
        if (line && !sameItem) {
          draftSeq.current += 1;
          toSend = draftItems.map((it) =>
            it.id === editingId
              ? {
                  id: `draft-${draftSeq.current}`,
                  product_id: pending.id,
                  sku: pending.sku,
                  name: pending.name,
                  qty: n,
                  unit_price: pending.base_price,
                  station: pending.station,
                  notes: line.notes,
                }
              : it,
          );
        } else if (line) {
          toSend = draftItems.map((it) => (it.id === editingId ? { ...it, qty: n } : it));
        } else {
          toSend = mergeDraftLine(draftItems, pending, n);
        }
      } else {
        toSend = mergeDraftLine(draftItems, pending, n);
      }
      setDraftItems(toSend);
      setPending(null);
      setEditingId(null);
      setNameLocked(false);
      setItemQuery("");
      setTyped("");
      setQtyStr("1");
      setListOpen(false);
    }
    if (!toSend.length) {
      onMessage("No items to print");
      return;
    }
    if (toSend.some((it) => it.qty < 0) && !remark.trim()) {
      remarkRef.current?.focus();
      return;
    }
    sendingKot.current = true;
    try {
      for (const it of toSend) {
        await api.post(`/api/orders/${id}/items`, {
          productId: it.product_id,
          qty: it.qty,
          notes: it.notes?.trim() || undefined,
          outlet: deptOutlet(dept),
        });
      }
      await api.post(`/api/orders/${id}/send-kot`, {
        remark: remark.trim() || undefined,
        steward: waiter.trim() || undefined,
        cardNumber: clubMode ? clubCard.trim() || undefined : undefined,
      });
      setDraftItems([]);
      goMainBilling();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "KOT failed");
      await clearServerUnsent(id).catch(() => null);
      if (barOnly) void onRefresh().catch(() => null);
    } finally {
      sendingKot.current = false;
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
    setTyped("");
    setQtyStr("1");
    setRemark("");
    setPick(0);
    setItemListSel(0);
    setOrderId(null);
    setDetail(null);
    setDraftItems([]);
    setTableId("");
    setTableCode("");
    setClubCard("");
    setClubBalPaise(0);
    setCheckCard("");
    setCheckBal("0.00");
    setGuest("");
    setMobile("");
    setSel(-1);
    setEditingId(null);
    onRefresh();
    setTimeout(() => {
      if (dept === "CLUB") clubCardRef.current?.focus();
      else tableRef.current?.focus();
    }, 0);
  }

  async function abandonPunch() {
    const oid = orderId;
    setDraftItems([]);
    if (oid) await clearServerUnsent(oid).catch(() => null);
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
    const here = (t.outlet || "BAR") === deptOutlet(dept);
    if (!here) return false;
    if (t.status === "AVAILABLE" || t.status === "PAYMENT_PENDING") return false;
    return ((t.running_total as number) || 0) > 0 || t.id === tableId;
  });

  async function openReopenList() {
    setListOpen(false);
    try {
      const invoices = await api.get<any[]>("/api/invoices");
      const open = invoices.filter((i) => i.status === "UNPAID" || i.status === "PARTIAL");
      const mapped: Table[] = [];
      for (const inv of open) {
        const t = tables.find((x) => x.id === inv.table_id);
        if (!t || (t.outlet || "BAR") !== deptOutlet(dept)) continue;
        if (!mapped.some((x) => x.id === t.id)) mapped.push(t);
      }
      if (!mapped.length) {
        onMessage("No bill to reopen");
        return;
      }
      setSettleTables(mapped);
      setPickOpen("reopen");
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "No bill to reopen");
    }
  }

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

  async function settleClubBill(invoiceId: string) {
    await api.post(`/api/invoices/${invoiceId}/settle-club`, {});
    onMessage("Settled");
    onRefresh();
  }

  async function openSettleForTable(t: Table) {
    try {
      const snap = await api.get<any>(`/api/tables/${t.id}/invoice`);
      setPickOpen(null);
      if ((t.outlet || deptOutlet(dept)) === "THE BOSS CLUB") {
        await settleClubBill(String(snap.invoice.id));
        return;
      }
      setSettleInv({ invoiceId: snap.invoice.id, table: t });
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "No bill to settle");
    }
  }

  async function openSettlement() {
    setListOpen(false);
    const outlet = deptOutlet(dept);
    const dayStart = businessStartMs();
    try {
      const rows = await api.get<Table[]>("/api/tables");
      const printedToday = rows.filter((t) => {
        if (t.status !== "PAYMENT_PENDING") return false;
        if ((t.outlet || "BAR") !== outlet) return false;
        if (!t.session_opened_at) return false;
        const opened = Date.parse(t.session_opened_at);
        return !Number.isNaN(opened) && opened >= dayStart;
      });
      if (!printedToday.length) {
        onMessage("No printed bill to settle");
        return;
      }
      setSettleTables(printedToday);
      setPickOpen("settle");
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "No printed bill to settle");
    }
  }

  useLayoutEffect(() => {
    if (listOpen) placeDrop();
  }, [listOpen, items.length]);

  // visiblePicks already windows the drop list — never scrollIntoView the
  // highlight (that scrolls the whole billing pane while typing / Enter).

  useEffect(() => {
    const n = listForPick().length;
    if (pick >= n) setPick(n ? n - 1 : 0);
  }, [matches.length, catalog.length, pending, nameLocked]);

  useLayoutEffect(() => {
    if (!focusEntry) return;
    itemRef.current?.focus();
    const body = gridBodyRef.current;
    const entry = body?.querySelector(".igrid-row.entry") as HTMLElement | null;
    if (body && entry && body.scrollHeight > body.clientHeight) {
      const top = entry.offsetTop;
      const bottom = top + entry.offsetHeight;
      if (top < body.scrollTop) body.scrollTop = top;
      else if (bottom > body.scrollTop + body.clientHeight) body.scrollTop = bottom - body.clientHeight;
    }
  }, [focusEntry, items.length, dept]);

  useEffect(() => {
    function isF11(ev: KeyboardEvent) {
      return ev.key === "F11" || ev.code === "F11" || ev.keyCode === 122;
    }
    function isF10(ev: KeyboardEvent) {
      return ev.key === "F10" || ev.code === "F10" || ev.keyCode === 121;
    }
    function keys(e: KeyboardEvent) {
      // A held Enter can move focus from item to qty, remark or Print KOT.
      const heldEnter = e.key === "Enter" && e.repeat ? kotEnter.current : null;
      if (heldEnter) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (e.key === "Enter" && !e.repeat) kotEnter.current = null;
      if (document.querySelector(".alert-dlg, .cm-dlg, .confirm-overlay")) return;
      if (askExit) return;
      if (noteItem) return;
      if (itemMasterOpen || compMasterOpen) {
        if (e.key.startsWith("F") && e.key.length > 1) e.preventDefault();
        return;
      }
      const fn = e.code || e.key;
      const outletShortcut = (e.altKey && /^[1-4]$/.test(e.key)) ||
        (e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"));
      if (barOnly && (/^F\d+$/.test(fn) || isF10(e) || isF11(e) || outletShortcut || e.key === "Escape")) {
        e.preventDefault();
        e.stopPropagation();
        if (fn === "F5" && !e.repeat) void printKot();
        return;
      }
      if (isF11(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (settleInv) return;
        if (billOrder) return;
        if (pickOpen === "settle" || pickOpen === "reopen") return;
        if (xferOpen || itemXferOpen) return;
        void openSettlement();
        return;
      }
      if (e.key === "F9" || e.code === "F9") {
        e.preventDefault();
        e.stopPropagation();
        if (access && !access.table) { onMessage("Permission denied"); return; }
        if (!pickOpen && !billOrder && !settleInv && !xferOpen && !itemXferOpen) setXferOpen(true);
        return;
      }
      if (isF10(e) || fn === "F10") {
        e.preventDefault();
        e.stopPropagation();
        if (!pickOpen && !billOrder && !settleInv && !xferOpen && !itemXferOpen) prepareBill();
        return;
      }
      // Table / item transfer owns the keyboard (Outlet Up/Down, etc.)
      if (xferOpen || itemXferOpen) return;
      if (e.key === "Enter" && !pickOpen && !billOrder && !settleInv && !payOpen) {
        if (heldEnter) {
          if (heldEnter.printed || committingQty.current) return;
          if (pending) {
            if (!heldEnter.punched) {
              heldEnter.punched = true;
              void punchQty();
            }
          } else if (draftItems.length && !(e.target === itemRef.current && itemQuery.trim())) {
            heldEnter.printed = true;
            void printKot();
          }
          return;
        }
        if (!e.repeat && orderId && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          const fromQty = e.target === qtyRef.current;
          const fromPrint = e.target === kotBtnRef.current;
          if (fromQty || fromPrint || e.target === itemRef.current || e.target === remarkRef.current) {
            kotEnter.current = { punched: fromQty, printed: fromPrint };
          }
        }
      }
      if (e.altKey && e.key === "1") { e.preventDefault(); switchDept("CLUB"); }
      if (e.altKey && e.key === "2") { e.preventDefault(); switchDept("RESTAURANT"); }
      if (e.altKey && e.key === "3") { e.preventDefault(); if (!advance) switchDept("NC"); }
      if (e.altKey && e.key === "4") { e.preventDefault(); switchDept("BAR"); }
      if (e.ctrlKey && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        e.stopPropagation();
        stepDept(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (e.key === "F3" || e.code === "F3") {
        e.preventDefault();
        e.stopPropagation();
        if (access && !access.item) { onMessage("Permission denied"); return; }
        if (!pickOpen && !billOrder && !settleInv) setItemMasterOpen(true);
        return;
      }
      if (pickOpen || billOrder || settleInv) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (payOpen) setPayOpen(false);
        else requestExit();
      }
      if (e.key === "F1") {
        e.preventDefault();
        e.stopPropagation();
        if (cashier || (access && !access.comp)) { onMessage("Permission denied"); return; }
        if (!pickOpen && !billOrder && !settleInv) setCompMasterOpen(true);
      }
      if (e.key === "F4" || e.code === "F4") {
        e.preventDefault();
        e.stopPropagation();
        if (access && !access.itemXfer) { onMessage("Permission denied"); return; }
        setItemXferOpen(true);
      }
      if (e.key === "F5" || e.key === "F6" || e.key === "F16") { e.preventDefault(); if (!e.repeat) void printKot(); }
      if (e.key === "F7") { e.preventDefault(); onOpenView("kot-report", deptOutlet(dept)); }
      if (e.key === "F8") { e.preventDefault(); onOpenView("bill-report", deptOutlet(dept)); }
      if (e.key === "F12") { e.preventDefault(); onOpenView("settlement-report", deptOutlet(dept)); }
    }
    keyHandler.current = keys;
  });
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyHandler.current(e);
    const up = (e: KeyboardEvent) => {
      if (e.key === "Enter") kotEnter.current = null;
      if (e.key === "F11" || e.code === "F11" || e.keyCode === 122) e.preventDefault();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, []);

  const dayStartMs = businessStartMs();
  const occupied = tables.filter((t) => {
    if ((t.outlet || "BAR") !== deptOutlet(dept)) return false;
    if (t.status === "AVAILABLE") return false;
    if (advance && t.status === "PAYMENT_PENDING") return true;
    if (!(((t.running_total as number) || 0) > 0 || t.id === tableId)) return false;
    if (t.session_opened_at && Date.parse(t.session_opened_at) < dayStartMs) return false;
    return true;
  });
  const estimateRows = occupied;
  const nameInput = (
    <input
      ref={itemRef}
      autoComplete="off"
      spellCheck={false}
      tabIndex={4}
      style={{ width: "100%" }}
      value={nameLocked && pending ? pending.name : itemQuery}
      onChange={(e) => {
        if (nameLocked) return;
        const v = e.target.value;
        setItemQuery(v);
        setTyped(v);
        setPending(null);
        setPick(0);
        setListOpen(v.trim().length > 0);
      }}
      onFocus={() => {
        if (nameLocked) return;
        if (itemQuery.trim()) setListOpen(true);
      }}
      onKeyDown={(e) => {
        if (nameLockRef.current && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          nameLockRef.current = false;
          const upper = e.key.toUpperCase();
          queryRef.current = upper;
          setNameLocked(false);
          setPending(null);
          setItemQuery(upper);
          setTyped(upper);
          setPick(0);
          setListOpen(true);
          return;
        }
        if (e.key === "Backspace" && nameLocked) {
          e.preventDefault();
          e.stopPropagation();
          setNameLocked(false);
          setTyped(itemQuery);
          setListOpen(false);
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          if (listOpen) movePick(e.key === "ArrowDown" ? 1 : -1);
          else moveRow(e.key === "ArrowDown" ? 1 : -1);
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
          } else {
            e.preventDefault();
            e.stopPropagation();
            setListOpen(false);
            if (items.length > 0 && !itemQuery.trim()) {
              focusInput(remarkRef.current);
            } else {
              itemRef.current?.focus();
            }
          }
        }
      }}
    />
  );
  const qtyInput = pending ? (
    <input
      ref={qtyRef}
      autoComplete="off"
      inputMode="numeric"
      tabIndex={5}
      value={qtyStr}
      aria-invalid={qtyInvalid && parseQty(qtyStr) == null ? true : undefined}
      onChange={(e) => setQtyStr(e.target.value.replace(/[^\d-]/g, "").replace(/(?!^)-/g, ""))}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          if (!editingId) movePending(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          if (!editingId) movePending(1);
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          moveRow(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          bumpQty(1);
        } else if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          e.stopPropagation();
          const el = e.currentTarget;
          const allSelected = el.selectionStart === 0 && el.selectionEnd === el.value.length;
          // With Qty selected (usual after item pick), "-" starts typing -2 / -1 — do not bump to -1 then lose the minus.
          if (allSelected || qtyStr === "" || qtyStr === "1" || qtyStr === "-") {
            setQtyStr("-");
            delete el.dataset.replace;
            requestAnimationFrame(() => {
              const q = qtyRef.current;
              if (q) {
                delete q.dataset.replace;
                q.setSelectionRange(1, 1);
              }
            });
          } else {
            bumpQty(-1);
          }
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.stopPropagation();
        } else if (e.key === "Backspace") {
          const el = e.currentTarget;
          const allSelected = el.selectionStart === 0 && el.selectionEnd === el.value.length;
          if (allSelected || qtyStr === "1" || qtyStr === "-1" || qtyStr === "" || qtyStr === "-") {
            e.preventDefault();
            itemRef.current?.focus();
          }
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          void punchQty();
        }
      }}
    />
  ) : null;
  const estimateFor = (t: Table) => (dept === "NC" ? 0 : t.net_total ?? t.running_total) ?? 0;
  const listTotal = estimateRows.reduce((s, t) => s + estimateFor(t), 0);
  const clubDraftNet = draftItems.reduce((s, it) => s + netOf(it), 0);
  const clubRemain = clubBalPaise - clubDraftNet;
  const pendingQty = pending ? parseQty(qtyStr) : null;
  const estimateItems = draftItems
    .filter((item) => !(pending && pendingQty != null && item.id === editingId))
    .map((item) => ({ productId: item.product_id, qty: item.qty, notes: item.notes }));
  if (pending && pendingQty != null) {
    estimateItems.push({ productId: pending.id, qty: pendingQty, notes: draftItems.find((item) => item.id === editingId)?.notes });
  }
  const barPunchEstimate = barOnly && Boolean(orderId) && table?.status !== "PAYMENT_PENDING" && estimateItems.length > 0;
  const requestBody = (!barOnly || barPunchEstimate) && orderId && dept !== "NC" && estimateItems.length
    ? JSON.stringify({ items: estimateItems, outlet: deptOutlet(dept) })
    : "";
  const estimateKey = JSON.stringify([orderId, requestBody]);
  useEffect(() => {
    if (!orderId || !requestBody) return;
    let current = true;
    api.post<{ grandTotal: number }>(`/api/orders/${orderId}/estimate`, JSON.parse(requestBody))
      .then(({ grandTotal }) => { if (current) setDraftEstimate({ key: estimateKey, total: grandTotal }); })
      .catch(() => { if (current) setDraftEstimate({ key: estimateKey, total: null }); });
    return () => { current = false; };
  }, [orderId, requestBody, estimateKey]);

  const barTableRows = barOnly ? tables
    .filter((t) => (t.outlet || "BAR") === "BAR" && (
      t.status === "PAYMENT_PENDING" || (t.status !== "AVAILABLE" && t.status !== "RESERVED" && (t.has_running_order || t.id === tableId))
    ))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) || a.code.localeCompare(b.code)) : [];
  const showTableItems = Boolean(tableId);
  const estimateNet = requestBody
    ? (draftEstimate?.key === estimateKey ? draftEstimate.total : null)
    : table ? estimateFor(table) : 0;

  return (
    <div className="billing">
      <div className="billing-main">
        <div className="header-row">
          <div className="hdr">
            <label className="pair"><span className="lbl">Date</span>
              <WinClock />
            </label>
            <label className="pair"><span className="lbl">KOT No</span>
              <span className="kot-text">{kotNo}</span>
            </label>
            <div className="table-stack">
              {clubMode && (
                <label className="pair"><span>Card No</span>
                  <input
                    ref={clubCardRef}
                    className="win green"
                    data-num="card"
                    inputMode="numeric"
                    maxLength={4}
                    value={clubCard}
                    tabIndex={1}
                    autoFocus
                    title="Deduct amount"
                    onChange={(e) => setClubCard(cardNoDigits(e.target.value))}
                    onBlur={(e) => {
                      const typed = cardNoDigits(e.currentTarget.value);
                      if (typed && !cardNoReady(typed)) stayOnCard(clubCardRef.current);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      const typedCard = cardNoDigits(e.currentTarget.value);
                      setClubCard(typedCard);
                      if (!cardNoReady(typedCard)) {
                        stayOnCard(clubCardRef.current);
                        return;
                      }
                      void enterClubCard(typedCard);
                    }}
                  />
                </label>
              )}
              <label className="pair"><span>Table No</span>
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
                      void ensureOpenByCode(e.currentTarget.value);
                    }
                  }}
                />
              </label>
            </div>
          </div>

          <div className="dept-box">
            <div className="dept-yellow">
              <span className="dept-name">{dept}</span>
              {!barOnly && <div className="card-pane">
                <span>Card No. :</span>
                <input
                  ref={cardRef}
                  className="win"
                  data-num="card"
                  inputMode="numeric"
                  maxLength={4}
                  style={{ width: 70 }}
                  value={checkCard}
                  tabIndex={3}
                  title="Balance check"
                  onChange={(e) => setCheckCard(cardNoDigits(e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const typedCard = cardNoDigits(e.currentTarget.value);
                    if (!cardNoReady(typedCard)) {
                      stayOnCard(cardRef.current);
                      return;
                    }
                    void loadCard(typedCard, false).then((ok) => {
                      if (!ok) {
                        stayOnCard(cardRef.current);
                        return;
                      }
                      focusInput(orderId ? itemRef.current : tableRef.current);
                    });
                  }}
                  onBlur={() => {
                    if (!checkCard) return;
                    if (!cardNoReady(checkCard)) {
                      stayOnCard(cardRef.current);
                      return;
                    }
                    void loadCard(checkCard, false);
                  }}
                />
                <span>{checkBal}</span>
              </div>}
            </div>
            {!barOnly && <div className="dept-body">
              <button type="button" className={`dept-btn ${dept === "CLUB" ? "active" : ""}`} title="Alt+1" onClick={() => switchDept("CLUB")}>The Boss<br />Club</button>
              <button type="button" className={`dept-btn ${dept === "RESTAURANT" ? "active" : ""}`} title="Alt+2" onClick={() => switchDept("RESTAURANT")}>Restaurant</button>
              {!advance && <button type="button" className={`dept-btn ${dept === "NC" ? "active" : ""}`} title="Alt+3" onClick={() => switchDept("NC")}>NC</button>}
              <button type="button" className={`dept-btn ${dept === "BAR" ? "active" : ""}`} title="Alt+4" onClick={() => switchDept("BAR")}>Bar</button>
            </div>}
          </div>
        </div>

        <div className={`igrid${dept === "BAR" ? " bar-order-grid" : ""}`}>
          <div className="igrid-head">
            <div>No.</div>
            <div>Item Name</div>
            <div>Rate</div>
            <div>Qty</div>
          </div>
          <div className="igrid-body" ref={gridBodyRef}>
            {items.map((it, i) => (
              <div
                key={it.id}
                tabIndex={0}
                className={`igrid-row ${editingId === it.id ? "editing" : ""}`}
                onClick={(e) => { setSel(i); e.currentTarget.focus(); }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  setSel(i);
                  if (editingId === it.id) return;
                  setNoteItem(it);
                }}
                onKeyDown={(e) => {
                  const target = e.target as HTMLElement;
                  if (target.closest("input, textarea, select")) return;
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    moveRow(-1);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveRow(1);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    startEdit(i);
                  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    replaceItem(i, e.key);
                  }
                }}
              >
                <div>{i + 1}</div>
                <div className={`cell-name ${sel === i ? "sel" : ""}`}>
                  {editingId === it.id ? nameInput : <>{it.name}{it.notes ? ` (${it.notes})` : ""}</>}
                </div>
                <div>{editingId === it.id ? (pending ? amt(pending.base_price) : "") : amt(it.unit_price)}</div>
                <div className="cell-qty">{editingId === it.id ? qtyInput : it.qty}</div>
              </div>
            ))}
            <div className="igrid-row entry" onClick={() => setSel(items.length)}>
              <div>{items.length + 1}</div>
              <div className={`cell-name ${!editingId && (sel < 0 || sel >= items.length) && (listOpen || (pending && nameLocked)) ? "sel" : ""}`}>
                {editingId ? null : nameInput}
              </div>
              <div>{!editingId && pending ? amt(pending.base_price) : ""}</div>
              <div className="cell-qty">{editingId ? null : qtyInput}</div>
            </div>
                {listOpen && listForPick().length > 0 && (
              <div
                ref={dropRef}
                className="item-drop"
                style={{ top: dropPos.top, left: dropPos.left }}
                onMouseDown={(e) => e.preventDefault()}
              >
                {visiblePicks(listForPick(), pick).map(({ p, i }) => (
                  <div
                    key={p.id}
                    className={i === pick ? "on" : ""}
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
            onBlur={() => {
              if (draftItems.some((it) => it.qty < 0) && !remark.trim()) {
                requestAnimationFrame(() => remarkRef.current?.focus());
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                e.stopPropagation();
                if (draftItems.some((it) => it.qty < 0) && !remark.trim()) {
                  remarkRef.current?.focus();
                  return;
                }
                kotBtnRef.current?.focus();
              }
            }}
          /></div>
          <table className="fn-table">
            <tbody>
              <tr>
                <td><button className="fn" disabled={barOnly} onClick={prepareBill}>Prepare Bill (F10)</button></td>
                <td><button className="fn" disabled={barOnly} onClick={openSettlement}>Settlement (F11)</button></td>
                <td><button
                  ref={kotBtnRef}
                  className="fn"
                  tabIndex={7}
                  onClick={() => void printKot()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!e.repeat) void printKot();
                    }
                  }}
                >Print KOT (F5)</button></td>
                <td><button className="fn" disabled={barOnly} onKeyDown={ignoreRepeatedPrintKey} onClick={printKot}>Save (F5)</button></td>
                <td><button className="fn" disabled={barOnly || advance || cashier} onClick={() => { if (access && !access.comp) onMessage("Permission denied"); else setCompMasterOpen(true); }}>F1 Complim.</button></td>
                <td className="exit-cell">
                  {((!barOnly && showTableItems) || barPunchEstimate) && (
                    <div className="dashboard-estimate">Net Estimate: {estimateNet == null ? "—" : amt(estimateNet)}</div>
                  )}
                  <button className="fn" disabled={barOnly} onClick={requestExit}>Exit</button>
                </td>
              </tr>
              <tr>
                <td><button className="fn" disabled={barOnly || !canOpenReport("kot-report")} onClick={() => onOpenView("kot-report", deptOutlet(dept))}>KOT Rep. (F7)</button></td>
                <td><button className="fn" disabled={barOnly || !canOpenReport("bill-report")} onClick={() => onOpenView("bill-report", deptOutlet(dept))}>Bill Rep. (F8)</button></td>
                <td><button className="fn" disabled={barOnly || !canOpenReport("settlement-report")} onClick={() => onOpenView("settlement-report", deptOutlet(dept))}>S. Report (F12)</button></td>
                <td><button className="fn" disabled={barOnly} onClick={() => { if (access && !access.itemXfer) onMessage("Permission denied"); else setItemXferOpen(true); }}>Item transfer (F4)</button></td>
                <td><button className="fn" disabled={barOnly} onClick={() => { if (access && !access.table) onMessage("Permission denied"); else setXferOpen(true); }}>T. Transfer (F9)</button></td>
                <td><button className="fn" disabled={barOnly || advance || cashier} onClick={() => { if (access && !access.item) onMessage("Permission denied"); else setItemMasterOpen(true); }}>Create Item (F3)</button></td>
              </tr>
            </tbody>
          </table>
          {clubMode && clubCard.trim() ? (
            <div className="club-card-bal">
              <span className="lbl">Card Bal</span>
              <span className="num">{amt(clubBalPaise)}</span>
              <span className="op">−</span>
              <span className="lbl">Unsent Item Net</span>
              <span className="num">{amt(clubDraftNet)}</span>
              <span className="op">=</span>
              <span className="lbl">Remain</span>
              <span className="num">{amt(clubRemain)}</span>
            </div>
          ) : null}
        </div>
      </div>

      <aside className={`estimate ${!barOnly && !advance && showTableItems ? "item-list" : ""}`}>
        {barOnly ? (
          <>
            <div className="estimate-head">Bar Table List</div>
            <div className="bar-table-scroll" role="region" aria-label="Bar tables" tabIndex={0}>
              <table>
                <thead><tr><th>Table No.</th><th>Status</th></tr></thead>
                <tbody>
                  {barTableRows.map((t) => {
                    const printed = t.status === "PAYMENT_PENDING";
                    return (
                      <tr key={t.id} className={printed ? "settle" : "occ"}>
                        <td>
                          {printed ? t.code : (
                            <button type="button" className="est-amt" onClick={() => void ensureOpenByCode(t.code)}>
                              {t.code}
                            </button>
                          )}
                        </td>
                        <td>{printed ? "Settlement" : "Bill"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="estimate-fill" />
          </>
        ) : !advance && showTableItems ? (
          <>
            <div className="estimate-head">Table No. Items List</div>
            <table>
              <colgroup><col className="c-code" /><col /><col className="c-qty" /></colgroup>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Item Name</th>
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
          </>
        ) : (
          <>
            <div className="estimate-head">{advance ? "Table List [F10 Prepare Bill]" : "Table Estimate [F10 Prepare Bill]"}</div>
            <div className={advance ? "bar-table-scroll" : undefined}>
            <table>
              <colgroup><col className={clubMode ? "c1 club" : "c1"} />{!advance && <col className="c2" />}<col /></colgroup>
              <thead>
                <tr>
                  <th>Table No.</th>
                  {!advance && <th>Estimate</th>}
                  <th>Bill/Settle</th>
                </tr>
              </thead>
              <tbody>
                {estimateRows.map((t) => {
                  const settle = t.status === "PAYMENT_PENDING";
                  return (
                    <tr
                      key={t.id}
                      className={settle ? "settle" : "occ"}
                      tabIndex={0}
                      onClick={() => {
                        if (settle) void openSettleForTable(t);
                        else void openBillForTable(t);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        if (settle) void openSettleForTable(t);
                        else void openBillForTable(t);
                      }}
                    >
                      <td
                        onClick={(e) => {
                          e.stopPropagation();
                          void ensureOpenByCode(t.code);
                        }}
                      >
                        {formatTableNo(t.code, t.card_number, t.outlet || (clubMode ? "THE BOSS CLUB" : ""))}
                      </td>
                      {!advance && <td>
                        <button
                          type="button"
                          className="est-amt"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openBillForTable(t);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            e.stopPropagation();
                            void openBillForTable(t);
                          }}
                        >
                          {amt(estimateFor(t))}
                        </button>
                      </td>}
                      <td className={settle ? "" : "bill"}>{advance ? (
                        <button type="button" className="fn" onKeyDown={(e) => e.stopPropagation()} onClick={(e) => {
                          e.stopPropagation();
                          if (settle) void openSettleForTable(t);
                          else void openBillForTable(t);
                        }}>{settle ? "Settlement" : "Bill"}</button>
                      ) : settle ? "Settlement" : "Bill"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            <div className="estimate-fill" />
            {!advance && <div className="estimate-total">Total Amount : {amt(listTotal)}</div>}
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
      {noteItem && (
        <ItemNotesDialog
          itemName={noteItem.name}
          initialNotes={noteItem.notes ?? ""}
          onClose={() => {
            setNoteItem(null);
            setEditingId(null);
            setSel(items.length);
            setFocusEntry((x) => x + 1);
            focusInput(itemRef.current);
          }}
          onSave={(notes) => {
            const cleaned = notes.trim();
            setDraftItems((prev) =>
              prev.map((it) => (it.id === noteItem.id ? { ...it, notes: cleaned || undefined } : it)),
            );
            setNoteItem(null);
            setEditingId(null);
            setSel(draftItems.length);
            setFocusEntry((x) => x + 1);
            focusInput(itemRef.current);
          }}
        />
      )}
      {xferOpen && (
        <TransferDialog
          outlets={advance ? ADVANCE_OUTLETS : undefined}
          tables={tables}
          outlet={deptOutlet(dept)}
          currentCode={tableCode}
          onClose={() => setXferOpen(false)}
          onDone={(fromCode, to) => {
            setXferOpen(false);
            onRefresh();
            const toOutlet = to.outlet || "BAR";
            onMessage(`Transferred ${fromCode} to ${to.code} (${toOutlet})`);
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
          title={pickOpen === "settle" ? "Settlement" : pickOpen === "reopen" ? "Reopen Bill" : "Prepare Bill"}
          tables={pickOpen === "bill" ? runningForBill : settleTables}
          onPick={(t) => void (pickOpen === "settle" ? openSettleForTable(t) : openBillForTable(t))}
          onClose={() => setPickOpen(null)}
        />
      )}
      {billOrder && (
        <PrepareBillDialog
          advance={advance}
          cashier={cashier}
          orderId={billOrder.orderId}
          table={billOrder.table}
          outlet={deptOutlet(dept)}
          waiter={waiter}
          guest={guest}
          mobile={mobile}
          catalog={catalog}
          onChanged={() => onRefresh()}
          onClose={() => setBillOrder(null)}
          onPrinted={(inv) => {
            onInvoice(inv);
            setBillOrder(null);
            setOrderId(null);
            setDetail(null);
            setTableId("");
            setTableCode("");
            onRefresh();
          }}
          onSettle={(inv) => {
            const table = billOrder.table;
            onInvoice(inv);
            setBillOrder(null);
            setOrderId(null);
            setDetail(null);
            setTableId("");
            setTableCode("");
            onRefresh();
            if ((table.outlet || deptOutlet(dept)) === "THE BOSS CLUB") {
              void settleClubBill(String(inv.id)).catch((e) => {
                onMessage(e instanceof Error ? e.message : "Could not settle");
              });
              return;
            }
            setSettleInv({ invoiceId: String(inv.id), table });
          }}
          onMessage={onMessage}
        />
      )}
      {settleInv && (
        <SettleDialog
          invoiceId={settleInv.invoiceId}
          table={settleInv.table}
          outlet={deptOutlet(dept)}
          cardNo={clubMode ? clubCard : checkCard}
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
          onSaved={() => onCatalog()}
        />
      )}
      {compMasterOpen && (
        <ComplimentaryMasterDialog onClose={() => setCompMasterOpen(false)} />
      )}
    </div>
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
          {tables.map((t) => <option key={t.id} value={t.id}>{formatTableNo(t.code, t.card_number, t.outlet)}</option>)}
        </select>
        <select className="win" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 120 }}>
          <option value="">To</option>
          {tables.map((t) => <option key={t.id} value={t.id}>{formatTableNo(t.code, t.card_number, t.outlet)}</option>)}
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
                <div className="code">{formatTableNo(t.code, t.card_number, t.outlet)}</div>
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
              <td>{formatINR(c.paid_balance + c.bonus_balance)}</td><td>{formatUiLabel(c.status)}</td>
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
  const [error, setError] = useState("");
  return (
    <div className="grid two">
      <div><CardSearch onPick={(picked) => {
        setCard(picked);
        setResult("");
        setError("");
      }} /></div>
      <div>
        {card ? (
          <>
            <p>{card.customer_name} · {card.card_number} · {formatINR(card.paid_balance + card.bonus_balance)} · {formatUiLabel(card.status)}</p>
            <div className="btn-row">{[500, 1000, 2000, 5000].map((p) => <button key={p} className="fn" onClick={() => setAmount(p * 100)}>₹{p}</button>)}</div>
            <input className="win" type="number" value={amount / 100} onChange={(e) => setAmount(Math.round(Number(e.target.value) * 100))} />
            <div className="btn-row">{(["CASH", "UPI", "CARD", "OTHER"] as PaymentMode[]).map((m) => <button key={m} className="fn" onClick={() => setMode(m)}>{m}</button>)}</div>
            <button className="fn wide" disabled={card.status !== "ACTIVE"} onClick={async () => {
              setError("");
              setResult("");
              try {
                const r = await api.post<{ card: Card }>(`/api/cards/${card.id}/recharge`, { amount, paymentMode: mode, printReceipt: true });
                setCard(r.card);
                setResult(`New ${formatINR(r.card.paid_balance + r.card.bonus_balance)}`);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Recharge failed");
              }
            }}>Recharge</button>
            {error && <p role="alert">{error}</p>}
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
          <p>{data.card.customer_name} · {data.card.card_number} · {formatUiLabel(data.card.status)}</p>
          <p><b>{formatINR(data.balances.usable)}</b></p>
        </div>
      )}
    </div>
  );
}

function CardsScreen() {
  const [cards, setCards] = useState<Card[]>([]);
  const [form, setForm] = useState({ name: "", mobile: "", cardNumber: "", cardUid: "", cardTypeCode: "MEMBER" });
  const cardNoRef = useRef<HTMLInputElement>(null);
  useEffect(() => { api.get<Card[]>("/api/cards").then(setCards); }, []);
  return (
    <div className="grid two">
      <div>
        <input className="win" placeholder="Member name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="win" placeholder="Mobile" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} style={{ marginTop: 6 }} />
        <input ref={cardNoRef} className="win" data-num="card" inputMode="numeric" maxLength={4} placeholder="Card number" value={form.cardNumber} onChange={(e) => setForm({ ...form, cardNumber: cardNoDigits(e.target.value) })} onBlur={() => { if (form.cardNumber && !cardNoReady(form.cardNumber)) stayOnCard(cardNoRef.current); }} style={{ marginTop: 6 }} />
        <input className="win" placeholder="RFID UID" value={form.cardUid} onChange={(e) => setForm({ ...form, cardUid: e.target.value })} style={{ marginTop: 6 }} />
        <select className="win" value={form.cardTypeCode} onChange={(e) => setForm({ ...form, cardTypeCode: e.target.value })} style={{ marginTop: 6 }}>
          <option value="REGULAR">Regular</option><option value="MEMBER">Member</option><option>VIP</option><option value="CORPORATE">Corporate</option>
        </select>
        <button className="fn wide" style={{ marginTop: 8 }} onClick={async () => {
          if (!cardNoReady(form.cardNumber)) { stayOnCard(cardNoRef.current); return; }
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
              <td>{formatINR(c.paid_balance + c.bonus_balance)}</td><td>{formatUiLabel(c.status)}</td>
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
  const numberRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <CardSearch onPick={setOldCard} />
      {oldCard && (
        <>
          <p>Old {oldCard.card_number} · {formatINR(oldCard.paid_balance + oldCard.bonus_balance)}</p>
          <input ref={numberRef} className="win" data-num="card" inputMode="numeric" maxLength={4} placeholder="New card number" value={number} onChange={(e) => setNumber(cardNoDigits(e.target.value))} onBlur={() => { if (number && !cardNoReady(number)) stayOnCard(numberRef.current); }} />
          <select className="win" value={reason} onChange={(e) => setReason(e.target.value)} style={{ marginTop: 6 }}>
            <option>Damaged</option><option>Lost</option><option>Customer request</option>
          </select>
          <button className="fn wide" style={{ marginTop: 8 }} onClick={async () => {
            if (!cardNoReady(number)) { stayOnCard(numberRef.current); return; }
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
        {["RECHARGE","PURCHASE","REFUND","TRANSFER","CARD_SWAP","ADJUSTMENT","BONUS","EXPIRY","REVERSAL"].map((t) => <option key={t} value={t}>{formatUiLabel(t)}</option>)}
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
          <b>{col === "SENT" ? "New Orders" : formatUiLabel(col)}</b>
          {kots.filter((k) => k.status === col || (col === "SENT" && k.status === "NEW")).map((k) => (
            <div key={k.id} className="kot-ticket">
              <b>{k.kot_number}</b>
              <div className="meta">Table {k.table_label || k.table_code} · {formatUiLabel(k.station)}</div>
              {k.reprint_count > 0 && <div className="reprint-mark">*** REPRINT ***</div>}
              <ul>{k.items?.map((i: any) => <li key={i.id}>{i.qty} × {i.name}</li>)}</ul>
              {next[k.status] && <button className="fn wide" onClick={() => api.post(`/api/kots/${k.id}/status`, { status: next[k.status] }).then(load)}>{next[k.status]}</button>}
              <button className="fn wide" onKeyDown={ignoreRepeatedPrintKey} onClick={() => reprintKot(k.id).then(load)}>Reprint</button>
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
            <td>{o.order_number}</td><td>{o.table_label || o.table_code}</td><td>{formatUiLabel(o.status)}</td><td>{formatINR(o.total)}</td>
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
  return <table className="data"><thead><tr><th>SKU</th><th>Name</th><th>Station</th><th>Price</th></tr></thead><tbody>{products.map((p) => <tr key={p.id}><td>{p.sku}</td><td>{p.name}</td><td>{formatUiLabel(p.station)}</td><td>{formatINR(p.base_price)}</td></tr>)}</tbody></table>;
}

function InventoryScreen() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>("/api/inventory").then(setRows); }, []);
  return <table className="data"><thead><tr><th>Product</th><th>Station</th><th>Qty</th></tr></thead><tbody>{rows.map((r) => <tr key={r.id}><td>{r.name}</td><td>{formatUiLabel(r.station)}</td><td>{r.quantity}</td></tr>)}</tbody></table>;
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
  return <table className="data"><thead><tr><th>Name</th><th>User</th><th>Role</th></tr></thead><tbody>{rows.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.username}</td><td>{formatUiLabel(s.role)}</td></tr>)}</tbody></table>;
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
        <thead><tr><th>Invoice</th><th>Table</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.invoice_number}</td><td>{r.table_label || r.table_code}</td><td>{formatINR(r.grand_total)}</td><td>{formatUiLabel(r.status)}</td>
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
  const cardRef = useRef<HTMLInputElement>(null);
  return (
    <div style={{ maxWidth: 420 }}>
      <input className="win" placeholder="Guest name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="win" placeholder="Mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} style={{ marginTop: 6 }} />
      <input ref={cardRef} className="win" data-num="card" inputMode="numeric" maxLength={4} placeholder="Member card" value={cardQ} onChange={(e) => setCardQ(cardNoDigits(e.target.value))} onBlur={() => { if (cardQ && !cardNoReady(cardQ)) stayOnCard(cardRef.current); }} style={{ marginTop: 6 }} />
      <select className="win" value={tableId} onChange={(e) => setTableId(e.target.value)} style={{ marginTop: 6 }}>
        {tables.filter((t) => t.status === "AVAILABLE").map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
      </select>
      <button className="fn wide" style={{ marginTop: 8 }} onClick={async () => {
        if (cardQ && !cardNoReady(cardQ)) { stayOnCard(cardRef.current); return; }
        const customer = await api.post<any>("/api/customers", { name, mobile });
        const found = cardQ ? await api.get<Card[]>(`/api/cards?q=${encodeURIComponent(cardQ)}`) : [];
        await api.post(`/api/tables/${tableId}/checkin`, { customerId: customer.id, cardId: found[0]?.id });
        onDone();
      }}>Check in</button>
    </div>
  );
}
