import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import { formatINR } from "../shared/money";
import type { NavView, PaymentMode, StaffRole } from "../shared/types";

type Actor = { staffId: string; staffName: string; role: StaffRole; terminalId: string; terminalName: string };
type Table = {
  id: string; code: string; name: string; status: string; floor_name: string; floor_id: string;
  current_session_id: string | null; customer_name?: string; card_number?: string; running_total?: number;
};
type Product = { id: string; name: string; station: string; base_price: number; sku: string };
type Card = {
  id: string; card_number: string; customer_name: string; mobile: string; paid_balance: number;
  bonus_balance: number; status: string; card_type_code: string; last_used_at?: string;
};
type OrderItem = { id: string; name: string; qty: number; unit_price: number; station: string; notes?: string; kot_id?: string };
type Invoice = {
  id: string; invoice_number: string; grand_total: number; food_total: number; drinks_total: number;
  service_charge: number; discount: number; tax: number; other_charges: number; status: string; table_id: string;
};

const NAV: Array<{ id: NavView; label: string; group: string }> = [
  { id: "home", label: "POS", group: "Floor" },
  { id: "tables", label: "Tables", group: "Floor" },
  { id: "orders", label: "Orders", group: "Floor" },
  { id: "kot", label: "KOT", group: "Floor" },
  { id: "kitchen", label: "Kitchen", group: "Floor" },
  { id: "bar", label: "Bar", group: "Floor" },
  { id: "cards", label: "Member Cards", group: "Cards" },
  { id: "recharge", label: "Recharge", group: "Cards" },
  { id: "customers", label: "Customers", group: "Cards" },
  { id: "products", label: "Products", group: "Ops" },
  { id: "inventory", label: "Inventory", group: "Ops" },
  { id: "purchase", label: "Purchase", group: "Ops" },
  { id: "expenses", label: "Expenses", group: "Ops" },
  { id: "reports", label: "Reports", group: "Admin" },
  { id: "staff", label: "Staff", group: "Admin" },
  { id: "settings", label: "Settings", group: "Admin" },
];

const QUICK: Array<{ id: NavView; label: string; hint: string; glyph: string }> = [
  { id: "pos", label: "New Bill", hint: "Open a table", glyph: "N" },
  { id: "tables", label: "Tables", hint: "Floor map", glyph: "T" },
  { id: "recharge", label: "Recharge", hint: "Load card", glyph: "₹" },
  { id: "balance", label: "Balance", hint: "Scan card", glyph: "B" },
  { id: "swap", label: "Card Swap", hint: "Replace card", glyph: "S" },
  { id: "orders", label: "Orders", hint: "Open checks", glyph: "O" },
  { id: "kot", label: "KOT", hint: "Tickets", glyph: "K" },
  { id: "history", label: "Bills", hint: "History", glyph: "H" },
  { id: "history", label: "Reprint", hint: "Last bill", glyph: "P" },
  { id: "reports", label: "Day Close", hint: "Reconcile", glyph: "D" },
];

const MENUS: Array<{ id: string; label: string; items: Array<{ label: string; view: NavView }> }> = [
  { id: "file", label: "File", items: [{ label: "New Bill\tCtrl+N", view: "pos" }, { label: "Day Close", view: "reports" }, { label: "Settings", view: "settings" }] },
  { id: "floor", label: "Floor", items: [{ label: "Tables", view: "tables" }, { label: "Orders", view: "orders" }, { label: "KOT", view: "kot" }, { label: "Kitchen Display", view: "kitchen" }, { label: "Bar Display", view: "bar" }] },
  { id: "cards", label: "Cards", items: [{ label: "Member Cards", view: "cards" }, { label: "Recharge", view: "recharge" }, { label: "Balance Check", view: "balance" }, { label: "Card Swap", view: "swap" }, { label: "Card Ledger", view: "ledger" }] },
  { id: "ops", label: "Operations", items: [{ label: "Customers", view: "customers" }, { label: "Products", view: "products" }, { label: "Inventory", view: "inventory" }, { label: "Purchase", view: "purchase" }, { label: "Expenses", view: "expenses" }] },
  { id: "help", label: "Help", items: [{ label: "Reports", view: "reports" }, { label: "Staff", view: "staff" }] },
];

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <time>
      {now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
      <br />
      {now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
    </time>
  );
}

export function App() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [view, setView] = useState<NavView>("home");
  const [bootstrap, setBootstrap] = useState<any>(null);
  const [error, setError] = useState("");
  const [activeTable, setActiveTable] = useState<Table | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<any>(null);
  const [maximized, setMaximized] = useState(true);
  const [menu, setMenu] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);

  async function refresh() {
    const data = await api.get<any>("/api/bootstrap");
    setBootstrap(data);
    if (!actor) setActor(data.actor);
  }

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  function go(next: NavView) {
    setView(next);
    setMenu(null);
    setStartOpen(false);
  }

  if (!bootstrap) {
    return (
      <div className="desktop">
        <div className="window">
          <div className="titlebar">
            <div className="titlebar-icon" />
            <div className="titlebar-title">BOSS Hyperlounge POS</div>
          </div>
          <div className="login"><div className="login-box card">Loading BOSS Hyperlounge POS…</div></div>
        </div>
        <div className="taskbar" />
      </div>
    );
  }

  const title = NAV.find((n) => n.id === view)?.label ?? view.toUpperCase();

  return (
    <div className={`desktop ${maximized ? "" : "restored"}`}>
      <div className="window">
        <header className="titlebar">
          <div className="titlebar-icon" />
          <div className="titlebar-title">BOSS Hyperlounge POS — {title}</div>
          <div className="titlebar-caption">
            <button type="button" aria-label="Minimize" onClick={() => setMaximized(false)}>─</button>
            <button type="button" aria-label="Maximize" onClick={() => setMaximized((v) => !v)}>□</button>
            <button type="button" className="close" aria-label="Close" onClick={() => go("home")}>✕</button>
          </div>
        </header>
        <div className="menubar-wrap">
          <nav className="menubar">
            {MENUS.map((m) => (
              <button key={m.id} className={menu === m.id ? "open" : ""} onClick={() => setMenu(menu === m.id ? null : m.id)}>
                {m.label}
              </button>
            ))}
          </nav>
          {menu && (
            <div className="menu-flyout" style={{ left: MENUS.findIndex((m) => m.id === menu) * 64 + 8 }}>
              {MENUS.find((m) => m.id === menu)?.items.map((item) => (
                <button key={item.label} onClick={() => go(item.view)}>{item.label}</button>
              ))}
            </div>
          )}
        </div>
        <div className="toolbar">
          {QUICK.map((q, i) => (
            <button key={`${q.label}-${i}`} className={view === q.id ? "active" : ""} onClick={() => go(q.id)}>
              <span className="glyph">{q.glyph}</span>
              {q.label}
            </button>
          ))}
        </div>
        <div className="app" onClick={() => setMenu(null)}>
          <aside className="nav">
            {["Floor", "Cards", "Ops", "Admin"].map((group) => (
              <div key={group}>
                <div className="section-label">{group}</div>
                {NAV.filter((n) => n.group === group).map((n) => (
                  <button key={n.id} className={view === n.id ? "active" : ""} onClick={() => go(n.id)}>
                    {n.label}
                  </button>
                ))}
              </div>
            ))}
          </aside>
          <main className="main">
            <div className="topbar">
              <div>
                <h1>{title}</h1>
                <div className="meta">{actor?.staffName} · {actor?.role} · {actor?.terminalName}</div>
              </div>
              <LoginBar actor={actor} onLogin={setActor} terminalId={bootstrap.actor.terminalId} />
            </div>
            {error && <p className="flash">{error}</p>}
            {view === "home" && <Home onGo={go} />}
            {view === "tables" || view === "pos" ? (
              <Tables
                tables={bootstrap.tables}
                onOpen={async (table) => {
                  setActiveTable(table);
                  if (table.status === "AVAILABLE") {
                    await api.post(`/api/tables/${table.id}/open`, {});
                    await refresh();
                  }
                  const latest = ((await api.get<Table[]>("/api/tables"))).find((t) => t.id === table.id);
                  const order = await api.post<any>("/api/orders", { tableId: table.id });
                  setActiveTable(latest ?? table);
                  setOrderId(order.id);
                  setView("pos");
                  await refresh();
                }}
                onRefresh={refresh}
                onCheckin={() => go("checkin")}
              />
            ) : null}
            {view === "pos" && activeTable && orderId && (
              <OrderScreen
                table={activeTable}
                orderId={orderId}
                products={bootstrap.products}
                onSettled={() => { setView("history"); setInvoice(null); refresh(); }}
                onInvoice={setInvoice}
              />
            )}
            {view === "orders" && <Orders onOpen={(id) => { setOrderId(id); go("pos"); }} />}
            {view === "kot" && <KotBoard station={undefined} />}
            {view === "kitchen" && <KotBoard station="KITCHEN" />}
            {view === "bar" && <KotBoard station="BAR" />}
            {view === "cards" && <CardsScreen />}
            {view === "recharge" && <RechargeScreen />}
            {view === "balance" && <BalanceScreen />}
            {view === "swap" && <SwapScreen />}
            {view === "ledger" && <LedgerScreen />}
            {view === "customers" && <CustomersScreen />}
            {view === "products" && <ProductsScreen products={bootstrap.products} />}
            {view === "inventory" && <InventoryScreen />}
            {view === "purchase" && <PurchaseScreen products={bootstrap.products} />}
            {view === "expenses" && <ExpensesScreen />}
            {view === "reports" && <ReportsScreen />}
            {view === "staff" && <StaffScreen />}
            {view === "settings" && <SettingsScreen settings={bootstrap.settings} onSaved={refresh} />}
            {view === "history" && <HistoryScreen invoice={invoice} />}
            {view === "checkin" && <CheckinScreen tables={bootstrap.tables} onDone={() => { go("tables"); refresh(); }} />}
          </main>
        </div>
        <footer className="statusbar">
          <span>Ready</span>
          <span>{bootstrap.sync?.online ? "Online" : "Offline"}</span>
          <span>Sync {bootstrap.sync?.pending ?? 0}</span>
          <span className="grow">{actor?.staffName} signed in</span>
          <span>{actor?.terminalName}</span>
        </footer>
      </div>
      {startOpen && (
        <div className="start-menu">
          <h2>BOSS Hyperlounge</h2>
          {NAV.map((n) => (
            <button key={n.id} onClick={() => go(n.id)}>{n.label}</button>
          ))}
        </div>
      )}
      <div className="taskbar">
        <button className={`start-btn ${startOpen ? "open" : ""}`} onClick={() => setStartOpen((v) => !v)} aria-label="Start">⊞</button>
        <button className="task-app" onClick={() => go("home")}>BOSS Hyperlounge POS</button>
        <div className="tray">
          <span>{bootstrap.sync?.online ? "●" : "○"} {actor?.role}</span>
          <Clock />
        </div>
      </div>
    </div>
  );
}

function Home({ onGo }: { onGo: (v: NavView) => void }) {
  return (
    <div className="grid quick-grid">
      {QUICK.map((q, i) => (
        <button key={`${q.label}-${i}`} className="tile" onClick={() => onGo(q.id)}>
          <em>{q.hint}</em>
          <strong>{q.label}</strong>
        </button>
      ))}
      <button className="tile" onClick={() => onGo("ledger")}><em>Ledger</em><strong>Card Ledger</strong></button>
      <button className="tile" onClick={() => onGo("checkin")}><em>Guest arrival</em><strong>Check-in</strong></button>
    </div>
  );
}

function LoginBar({ actor, onLogin, terminalId }: { actor: Actor | null; onLogin: (a: Actor) => void; terminalId: string }) {
  const [username, setUsername] = useState("cashier");
  const [pin, setPin] = useState("2222");
  return (
    <div className="btn-row">
      <select value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: 140 }}>
        <option value="owner">owner</option>
        <option value="manager">manager</option>
        <option value="cashier">cashier</option>
        <option value="waiter">waiter</option>
        <option value="kitchen">kitchen</option>
        <option value="bar">bar</option>
      </select>
      <input value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 90 }} />
      <button className="btn primary" onClick={async () => onLogin(await api.post("/api/auth/login", { username, pin, terminalId }))}>
        {actor ? "Switch user" : "Sign in"}
      </button>
    </div>
  );
}

function Tables({ tables, onOpen, onRefresh }: { tables: Table[]; onOpen: (t: Table) => void; onRefresh: () => void; onCheckin: () => void }) {
  const floors = useMemo(() => [...new Set(tables.map((t) => t.floor_name))], [tables]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  return (
    <div>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        <select value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }}>
          <option value="">From table</option>
          {tables.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
        </select>
        <select value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }}>
          <option value="">To table</option>
          {tables.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
        </select>
        <button className="btn" onClick={async () => { await api.post("/api/tables/transfer", { fromTableId: from, toTableId: to }); onRefresh(); }}>TRANSFER</button>
        <button className="btn" onClick={async () => { await api.post("/api/tables/merge", { sourceTableId: from, targetTableId: to }); onRefresh(); }}>MERGE</button>
      </div>
      {floors.map((floor) => (
        <section key={floor} style={{ marginBottom: 24 }}>
          <h2>{floor}</h2>
          <div className="grid table-grid" style={{ marginTop: 12 }}>
            {tables.filter((t) => t.floor_name === floor).map((t) => (
              <button key={t.id} className={`table-tile ${t.status}`} onClick={() => onOpen(t)}>
                <div className="code">{t.code}</div>
                <div className="status">{t.status.replace("_", " ")}</div>
                {t.customer_name && <div className="meta">{t.customer_name}</div>}
                {!!t.running_total && <div className="amount">{formatINR(t.running_total)}</div>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function OrderScreen({ table, orderId, products, onSettled, onInvoice }: {
  table: Table; orderId: string; products: Product[]; onSettled: () => void; onInvoice: (inv: any) => void;
}) {
  const [detail, setDetail] = useState<any>(null);
  const [bill, setBill] = useState<any>(null);
  const [note, setNote] = useState("");
  const [payMethod, setPayMethod] = useState<PaymentMode>("MEMBER_CARD");
  const [cardQuery, setCardQuery] = useState(table.card_number ?? "");
  const [msg, setMsg] = useState("");
  const [split, setSplit] = useState<{ method: PaymentMode; amount: string }[]>([{ method: "MEMBER_CARD", amount: "" }, { method: "CASH", amount: "" }]);

  async function load() {
    setDetail(await api.get(`/api/orders/${orderId}`));
    try {
      setBill(await api.post("/api/invoices/preview", { orderId }));
    } catch {
      setBill(null);
    }
  }
  useEffect(() => { load(); }, [orderId]);

  async function add(product: Product) {
    await api.post(`/api/orders/${orderId}/items`, { productId: product.id, qty: 1, notes: note || undefined });
    setNote("");
    await load();
  }

  async function sendKot() {
    await api.post(`/api/orders/${orderId}/send-kot`);
    setMsg("KOT sent to kitchen/bar");
    await load();
  }

  async function pay(lines: Array<{ method: PaymentMode; amount: number; memberCardId?: string }>) {
    try {
      const preview = await api.post<any>("/api/invoices/preview", { orderId });
      const invoice = await api.post<any>("/api/invoices/generate", { orderId });
      onInvoice(invoice);
      let memberCardId: string | undefined;
      if (lines.some((l) => l.method === "MEMBER_CARD") && cardQuery) {
        const found = await api.get<Card[]>(`/api/cards?q=${encodeURIComponent(cardQuery)}`);
        memberCardId = found[0]?.id;
      }
      const result = await api.post<any>(`/api/invoices/${invoice.id}/pay`, {
        lines: lines.map((l) => ({ ...l, memberCardId })),
        printReceipt: true,
      });
      setMsg(result.complete ? `Paid ${formatINR(preview.grandTotal)}. Receipt printed.` : "Partial payment recorded");
      if (result.complete) onSettled();
    } catch (e) {
      if (e instanceof ApiError && e.details) {
        const d = e.details as { required: number; available: number; shortfall: number };
        setMsg(`INSUFFICIENT CARD BALANCE — Required ${formatINR(d.required)} · Available ${formatINR(d.available)} · Shortfall ${formatINR(d.shortfall)}`);
      } else {
        setMsg(e instanceof Error ? e.message : "Payment failed");
      }
    }
  }

  const items: OrderItem[] = detail?.items ?? [];
  const total = items.reduce((s, i) => s + i.qty * i.unit_price, 0);

  return (
    <div className="grid two">
      <div className="panel">
        <h2>Table {table.code}</h2>
        <p className="meta">Tap a product. KOT prints by station. Bill is one click.</p>
        <input placeholder="Special instructions — no onion, less spicy" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="grid three" style={{ marginTop: 12 }}>
          {products.map((p) => (
            <button key={p.id} className="btn" onClick={() => add(p)}>
              <div>{p.name}</div>
              <div className="meta">{p.station} · {formatINR(p.base_price)}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="panel">
        <h2>Check</h2>
        <table className="data">
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.qty} × {i.name}</td>
                <td>{i.station}</td>
                <td>{formatINR(i.qty * i.unit_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="amount"><b>{formatINR(bill?.grandTotal ?? total)}</b></p>
        {bill && (
          <p className="meta">
            Food {formatINR(bill.foodTotal)} · Drinks {formatINR(bill.drinksTotal)} · Service {formatINR(bill.serviceCharge)} · Tax {formatINR(bill.tax)}
            {bill.discount ? ` · Discount ${formatINR(bill.discount)}` : ""}
          </p>
        )}
        <div className="btn-row">
          <button className="btn primary" onClick={sendKot}>SEND KOT</button>
          <button className="btn" onClick={() => api.post(`/api/tables/${table.id}/request-bill`).then(() => setMsg("Bill requested"))}>REQUEST BILL</button>
        </div>
        <hr style={{ borderColor: "var(--line)" }} />
        <input placeholder="Scan / card / mobile" value={cardQuery} onChange={(e) => setCardQuery(e.target.value)} />
        <div className="btn-row" style={{ marginTop: 8 }}>
          {(["MEMBER_CARD", "CASH", "UPI", "CARD"] as PaymentMode[]).map((m) => (
            <button key={m} className={`btn ${payMethod === m ? "primary" : ""}`} onClick={() => setPayMethod(m)}>{m.replace("_", " ")}</button>
          ))}
        </div>
        <button className="btn sage wide" style={{ marginTop: 10 }} onClick={async () => {
          const preview = await api.post<any>("/api/invoices/preview", { orderId });
          pay([{ method: payMethod, amount: preview.grandTotal }]);
        }}>PRINT + PAY {formatINR(bill?.grandTotal ?? total)}</button>
        <h3 style={{ marginTop: 16 }}>Split payment</h3>
        {split.map((s, idx) => (
          <div className="btn-row" key={idx} style={{ marginBottom: 6 }}>
            <select value={s.method} onChange={(e) => setSplit(split.map((x, i) => i === idx ? { ...x, method: e.target.value as PaymentMode } : x))}>
              <option>MEMBER_CARD</option><option>CASH</option><option>UPI</option><option>CARD</option>
            </select>
            <input placeholder="₹" value={s.amount} onChange={(e) => setSplit(split.map((x, i) => i === idx ? { ...x, amount: e.target.value } : x))} />
          </div>
        ))}
        <button className="btn wide" onClick={() => pay(split.filter((s) => Number(s.amount) > 0).map((s) => ({ method: s.method, amount: Math.round(Number(s.amount) * 100) })))}>COMPLETE SPLIT</button>
        {msg && <p className={msg.includes("INSUFFICIENT") ? "flash" : "ok"}>{msg}</p>}
      </div>
    </div>
  );
}

function CardSearch({ onPick }: { onPick: (c: Card) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Card[]>([]);
  return (
    <div>
      <input placeholder="Card number, mobile, name, RFID UID" value={q} onChange={async (e) => {
        setQ(e.target.value);
        if (e.target.value.length >= 2) setRows(await api.get(`/api/cards?q=${encodeURIComponent(e.target.value)}`));
      }} />
      <table className="data">
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} onClick={() => onPick(c)} style={{ cursor: "pointer" }}>
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
  const presets = [500, 1000, 2000, 5000];
  return (
    <div className="grid two">
      <div className="panel">
        <h2>Find card</h2>
        <CardSearch onPick={setCard} />
      </div>
      <div className="panel">
        {card ? (
          <>
            <h2>{card.customer_name}</h2>
            <p>{card.card_number} · {card.status}</p>
            <p>Current balance <b>{formatINR(card.paid_balance + card.bonus_balance)}</b></p>
            <div className="btn-row">
              {presets.map((p) => <button key={p} className={`btn ${amount === p * 100 ? "primary" : ""}`} onClick={() => setAmount(p * 100)}>₹{p.toLocaleString("en-IN")}</button>)}
            </div>
            <input style={{ marginTop: 10 }} type="number" value={amount / 100} onChange={(e) => setAmount(Math.round(Number(e.target.value) * 100))} />
            <div className="btn-row" style={{ margin: "10px 0" }}>
              {(["CASH", "UPI", "CARD", "OTHER"] as PaymentMode[]).map((m) => (
                <button key={m} className={`btn ${mode === m ? "primary" : ""}`} onClick={() => setMode(m)}>{m}</button>
              ))}
            </div>
            <p>New balance <b>{formatINR(card.paid_balance + card.bonus_balance + amount)}</b></p>
            <button className="btn primary wide" onClick={async () => {
              const r = await api.post<any>(`/api/cards/${card.id}/recharge`, { amount, paymentMode: mode, printReceipt: true });
              setCard(r.card);
              setResult(`Recharged. Ledger ${r.recharge.id}. New ${formatINR(r.card.paid_balance + r.card.bonus_balance)}`);
            }}>RECHARGE</button>
            {result && <p className="ok">{result}</p>}
          </>
        ) : <p className="meta">Search a card to recharge in two more taps.</p>}
      </div>
    </div>
  );
}

function BalanceScreen() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<any>(null);
  return (
    <div className="panel" style={{ maxWidth: 640 }}>
      <input autoFocus placeholder="Scan card / mobile / name" value={q} onChange={async (e) => {
        setQ(e.target.value);
        if (e.target.value.length >= 2) setData(await api.get(`/api/cards/balance/check?q=${encodeURIComponent(e.target.value)}`));
      }} />
      {data && (
        <div style={{ marginTop: 16 }}>
          <h2>{data.card.customer_name}</h2>
          <p>{data.card.card_number} · {data.card.status}</p>
          <p className="amount"><b>{formatINR(data.balances.usable)}</b></p>
          <p className="meta">Paid {formatINR(data.balances.paid)} · Bonus {formatINR(data.balances.bonus)}</p>
          {data.last && <p className="meta">Last {data.last.type} {formatINR(data.last.paid_amount + data.last.bonus_amount)} · {data.last.created_at}</p>}
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
      <div className="panel">
        <h2>Issue new card</h2>
        <input placeholder="Member name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="Mobile" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} style={{ marginTop: 8 }} />
        <input placeholder="Card number" value={form.cardNumber} onChange={(e) => setForm({ ...form, cardNumber: e.target.value })} style={{ marginTop: 8 }} />
        <input placeholder="RFID / NFC UID (optional)" value={form.cardUid} onChange={(e) => setForm({ ...form, cardUid: e.target.value })} style={{ marginTop: 8 }} />
        <select value={form.cardTypeCode} onChange={(e) => setForm({ ...form, cardTypeCode: e.target.value })} style={{ marginTop: 8 }}>
          <option>REGULAR</option><option>MEMBER</option><option>VIP</option><option>CORPORATE</option>
        </select>
        <button className="btn primary wide" style={{ marginTop: 12 }} onClick={async () => {
          await api.post("/api/cards/issue", { customer: { name: form.name, mobile: form.mobile }, cardNumber: form.cardNumber, cardUid: form.cardUid || undefined, cardTypeCode: form.cardTypeCode });
          setCards(await api.get("/api/cards"));
        }}>ISSUE + ACTIVATE</button>
      </div>
      <div className="panel">
        <h2>Cards</h2>
        <table className="data">
          <thead><tr><th>Card</th><th>Member</th><th>Balance</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id}>
                <td>{c.card_number}</td><td>{c.customer_name}<div className="meta">{c.mobile}</div></td>
                <td>{formatINR(c.paid_balance + c.bonus_balance)}</td><td>{c.status}</td>
                <td className="btn-row">
                  <button className="btn" onClick={() => api.post(`/api/cards/${c.id}/block`, { reason: "Lost" }).then(async () => setCards(await api.get("/api/cards")))}>BLOCK</button>
                  <button className="btn" onClick={() => api.post(`/api/cards/${c.id}/unblock`, { reason: "Customer request" }).then(async () => setCards(await api.get("/api/cards")))}>UNBLOCK</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SwapScreen() {
  const [oldCard, setOldCard] = useState<Card | null>(null);
  const [number, setNumber] = useState("");
  const [reason, setReason] = useState("Damaged");
  const [out, setOut] = useState("");
  return (
    <div className="panel" style={{ maxWidth: 720 }}>
      <h2>Replace damaged or lost card</h2>
      <CardSearch onPick={setOldCard} />
      {oldCard && (
        <>
          <p>Old card {oldCard.card_number} · {formatINR(oldCard.paid_balance + oldCard.bonus_balance)}</p>
          <input placeholder="New card number / scan" value={number} onChange={(e) => setNumber(e.target.value)} />
          <select value={reason} onChange={(e) => setReason(e.target.value)} style={{ marginTop: 8 }}>
            <option>Damaged</option><option>Lost</option><option>Customer request</option>
          </select>
          <button className="btn wine wide" style={{ marginTop: 12 }} onClick={async () => {
            const r = await api.post<any>("/api/cards/swap", { oldCardId: oldCard.id, newCardNumber: number, reason });
            setOut(`Transferred ${formatINR(r.transferred.usable)} to ${r.newCard.card_number}. Old card ${r.oldCard.status}.`);
          }}>SWAP BALANCE</button>
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
    <div className="panel">
      <div className="btn-row">
        <CardSearch onPick={(c) => load(c.id)} />
        <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 180 }}>
          <option value="">All types</option>
          {["RECHARGE","PURCHASE","REFUND","TRANSFER","CARD_SWAP","ADJUSTMENT","BONUS","EXPIRY","REVERSAL"].map((t) => <option key={t}>{t}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter note" />
      </div>
      <table className="data">
        <thead><tr><th>Txn</th><th>Type</th><th>Opening</th><th>Credit</th><th>Debit</th><th>Closing</th></tr></thead>
        <tbody>
          {rows.filter((r) => !q || JSON.stringify(r).includes(q)).map((r) => {
            const credit = r.direction === "CREDIT" ? r.paid_amount + r.bonus_amount : 0;
            const debit = r.direction === "DEBIT" ? r.paid_amount + r.bonus_amount : 0;
            return (
              <tr key={r.id}>
                <td>{r.id}<div className="meta">{r.card_number} · {r.created_at}</div></td>
                <td>{r.type}</td>
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
          <h3>{col === "SENT" ? "NEW ORDERS" : col}</h3>
          {kots.filter((k) => k.status === col || (col === "SENT" && k.status === "NEW")).map((k) => (
            <div key={k.id} className="kot-ticket">
              <h3>{k.kot_number}</h3>
              <div className="meta">TABLE {k.table_code} · {k.order_number} · {k.station}</div>
              {k.reprint_count > 0 && <div className="reprint-mark">*** REPRINT ***</div>}
              <ul>
                {k.items?.map((i: any) => <li key={i.id}>{i.qty} × {i.name}{i.notes ? ` — ${i.notes}` : ""}</li>)}
              </ul>
              {next[k.status] && <button className="btn sage wide" onClick={() => api.post(`/api/kots/${k.id}/status`, { status: next[k.status] }).then(load)}>{next[k.status]}</button>}
              <button className="btn ghost wide" onClick={() => api.post(`/api/kots/${k.id}/reprint`).then(load)}>REPRINT</button>
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
          <tr key={o.id} onClick={() => onOpen(o.id)} style={{ cursor: "pointer" }}>
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
      <div className="panel">
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} style={{ marginTop: 8 }} />
        <button className="btn primary wide" style={{ marginTop: 8 }} onClick={async () => { await api.post("/api/customers", { name, mobile }); setRows(await api.get("/api/customers")); }}>SAVE</button>
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
    <div className="panel" style={{ maxWidth: 480 }}>
      <input placeholder="Supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
      <select value={productId} onChange={(e) => setProductId(e.target.value)} style={{ marginTop: 8 }}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} style={{ marginTop: 8 }} />
      <button className="btn primary wide" style={{ marginTop: 8 }} onClick={() => api.post("/api/purchases", { supplier, items: [{ productId, qty, cost: 10000 }] })}>RECEIVE</button>
    </div>
  );
}

function ExpensesScreen() {
  const [category, setCategory] = useState("Utilities");
  const [amount, setAmount] = useState(0);
  return (
    <div className="panel" style={{ maxWidth: 420 }}>
      <input value={category} onChange={(e) => setCategory(e.target.value)} />
      <input type="number" placeholder="₹" onChange={(e) => setAmount(Math.round(Number(e.target.value) * 100))} style={{ marginTop: 8 }} />
      <button className="btn wide" style={{ marginTop: 8 }} onClick={() => api.post("/api/expenses", { category, amount })}>ADD EXPENSE</button>
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
  if (!dash) return <p>Loading reports…</p>;
  if (dash.error) return <p className="flash">{dash.error} — login as owner/manager to view reports.</p>;
  return (
    <div>
      <div className="grid three">
        <div className="card stat"><span>TODAY RECHARGE</span><b>{formatINR(dash.todayRecharge)}</b></div>
        <div className="card stat"><span>CARD SALES</span><b>{formatINR(dash.cardSales)}</b></div>
        <div className="card stat"><span>OUTSTANDING LIABILITY</span><b>{formatINR(dash.outstandingTotal)}</b></div>
        <div className="card stat"><span>BONUS BALANCE</span><b>{formatINR(dash.outstandingBonus)}</b></div>
        <div className="card stat"><span>REFUNDS</span><b>{formatINR(dash.refunds)}</b></div>
        <div className="card stat"><span>ACTIVE / BLOCKED</span><b>{dash.activeCards} / {dash.blockedCards}</b></div>
      </div>
      {rec && (
        <div className="panel" style={{ marginTop: 18 }}>
          <h2>Daily reconciliation</h2>
          <p>Opening {formatINR(rec.openingLiability)} + Recharge {formatINR(rec.recharges)} + Bonus {formatINR(rec.bonuses)} − Purchases {formatINR(rec.purchases)} + Refunds {formatINR(rec.refunds)} + Adj {formatINR(rec.adjustments)}</p>
          <p>Expected {formatINR(rec.expectedClosing)} · Actual {formatINR(rec.actualClosing)} · Difference <b>{formatINR(rec.difference)}</b></p>
          <button className="btn primary" onClick={() => api.post("/api/reports/day-close", {})}>DAY CLOSE</button>
        </div>
      )}
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
    <div className="panel" style={{ maxWidth: 520 }}>
      {Object.entries(form).map(([k, v]) => (
        <label key={k} style={{ display: "block", marginBottom: 10 }}>
          <div className="meta">{k}</div>
          <input value={v} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
        </label>
      ))}
      <button className="btn primary" onClick={async () => { await api.put("/api/settings", form); onSaved(); }}>SAVE SETTINGS</button>
    </div>
  );
}

function HistoryScreen({ invoice }: { invoice: Invoice | null }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>("/api/invoices").then(setRows); }, []);
  return (
    <div>
      {invoice && <p className="ok">Last invoice {invoice.invoice_number} · {formatINR(invoice.grand_total)}</p>}
      <table className="data">
        <thead><tr><th>Invoice</th><th>Table</th><th>Total</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.invoice_number}</td><td>{r.table_code}</td><td>{formatINR(r.grand_total)}</td><td>{r.status}</td>
              <td><button className="btn" onClick={() => api.post(`/api/invoices/${r.id}/print`)}>REPRINT</button></td>
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
    <div className="panel" style={{ maxWidth: 480 }}>
      <input placeholder="Guest name" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="Mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} style={{ marginTop: 8 }} />
      <input placeholder="Member card" value={cardQ} onChange={(e) => setCardQ(e.target.value)} style={{ marginTop: 8 }} />
      <select value={tableId} onChange={(e) => setTableId(e.target.value)} style={{ marginTop: 8 }}>
        {tables.filter((t) => t.status === "AVAILABLE").map((t) => <option key={t.id} value={t.id}>{t.floor_name} · {t.code}</option>)}
      </select>
      <button className="btn primary wide" style={{ marginTop: 12 }} onClick={async () => {
        const customer = await api.post<any>("/api/customers", { name, mobile });
        const found = cardQ ? await api.get<Card[]>(`/api/cards?q=${encodeURIComponent(cardQ)}`) : [];
        await api.post(`/api/tables/${tableId}/checkin`, { customerId: customer.id, cardId: found[0]?.id });
        onDone();
      }}>CHECK IN + OPEN TABLE</button>
    </div>
  );
}
