import { isBarOrderOnly } from "../../shared/userRights.js";
import { assertPermission } from "../../shared/permissions.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { nextNumber, nowIso, uuid } from "../lib/ids.js";
import type { KotPrintPayload } from "../hardware/index.js";
import { formatKotHtml } from "../hardware/kotReceiptHtml.js";
import { enqueueKotPrint, kotPrinters } from "./kotPrintQueue.js";
import { deductStock, restoreStock } from "./inventoryService.js";
import { displayTaxRate } from "./itemService.js";
import { resolvePrice } from "./pricingService.js";
import { assertOrderCardUsable, assertUsable, getCard } from "./cardService.js";
import { syncClubCardCharge } from "./billingService.js";
import { attachTableCard, getTable } from "./tableService.js";
import { printedTableNo } from "./tableLabel.js";
import { formatTableNo } from "../../shared/tableLabel.js";
import type { KotStatus, Station } from "../../shared/types.js";

export function getOpenOrderForSession(ctx: AppContext, sessionId: string) {
  return ctx.db
    .prepare("SELECT * FROM orders WHERE session_id = ? AND status IN ('OPEN','BILL_REQUESTED','SETTLING') ORDER BY created_at LIMIT 1")
    .get(sessionId) as
    | {
        id: string;
        order_number: string;
        session_id: string;
        table_id: string;
        waiter_id: string | null;
        customer_id: string | null;
        card_id: string | null;
        status: string;
      }
    | undefined;
}

export function createOrder(ctx: AppContext, tableId: string) {
  assertPermission(ctx.actor.role, "CREATE_ORDER");
  const table = getTable(ctx, tableId);
  if (!table.current_session_id) throw new AppError("Open the table before creating an order");
  const existing = getOpenOrderForSession(ctx, table.current_session_id);
  if (existing) {
    assertOrderCardUsable(ctx, existing.id);
    return existing;
  }

  const session = ctx.db
    .prepare("SELECT * FROM table_sessions WHERE id = ?")
    .get(table.current_session_id) as {
    customer_id: string | null;
    card_id: string | null;
    waiter_id: string | null;
  };

  if (session.card_id) assertUsable(getCard(ctx, session.card_id));
  const id = uuid();
  const orderNumber = nextNumber(ctx.db, "order", "ORD-");
  ctx.db
    .prepare(
      `INSERT INTO orders (id, order_number, session_id, table_id, waiter_id, customer_id, card_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
    )
    .run(
      id,
      orderNumber,
      table.current_session_id,
      table.id,
      session.waiter_id ?? ctx.actor.staffId,
      session.customer_id,
      session.card_id,
      nowIso(),
    );
  return ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
}

function productQty(
  ctx: AppContext,
  orderId: string,
  productId: string,
  notes: string,
  sentOnly: boolean,
  /** When false, sum all note variants of the product (cancel AAA after notes were set). */
  matchNotes = true,
) {
  if (matchNotes) {
    const row = ctx.db
      .prepare(
        `SELECT COALESCE(SUM(qty), 0) AS qty FROM order_items
         WHERE order_id = ? AND product_id = ? AND voided = 0
           AND IFNULL(notes,'') = ? ${sentOnly ? "AND kot_id IS NOT NULL" : ""}`,
      )
      .get(orderId, productId, notes) as { qty: number };
    return row.qty;
  }
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS qty FROM order_items
       WHERE order_id = ? AND product_id = ? AND voided = 0
         ${sentOnly ? "AND kot_id IS NOT NULL" : ""}`,
    )
    .get(orderId, productId) as { qty: number };
  return row.qty;
}

/** Pending (unsent) line for product — exact notes first, else any notes when punch has no note. */
function findPendingItem(
  ctx: AppContext,
  orderId: string,
  productId: string,
  notes: string,
) {
  const exact = ctx.db
    .prepare(
      `SELECT * FROM order_items
       WHERE order_id = ? AND product_id = ? AND IFNULL(notes,'') = ? AND kot_id IS NULL AND voided = 0`,
    )
    .get(orderId, productId, notes) as { id: string; qty: number; notes: string | null } | undefined;
  if (exact) return exact;
  if (notes !== "") return undefined;
  return ctx.db
    .prepare(
      `SELECT * FROM order_items
       WHERE order_id = ? AND product_id = ? AND kot_id IS NULL AND voided = 0
       ORDER BY rowid LIMIT 1`,
    )
    .get(orderId, productId) as { id: string; qty: number; notes: string | null } | undefined;
}

function voidOrderItem(ctx: AppContext, itemId: string) {
  ctx.db.prepare("UPDATE order_items SET voided = 1, status = 'VOID' WHERE id = ?").run(itemId);
}

function priceWithTax(unitPrice: number, taxRate: number) {
  const rate = Number(taxRate) || 0;
  return unitPrice + Math.round((unitPrice * rate) / 100);
}

const PUNCH_OUTLETS = new Set(["BAR", "RESTAURANT", "NC", "THE BOSS CLUB"]);

export function addItem(
  ctx: AppContext,
  input: { orderId: string; productId: string; qty: number; notes?: string; at?: Date; outlet?: string },
  billEdit?: { id: string; allowPaid: boolean },
) {
  assertPermission(ctx.actor.role, "CREATE_ORDER");
  if (!Number.isInteger(input.qty) || input.qty === 0) throw new AppError("Quantity must be a non-zero integer");
  const order = ctx.db
    .prepare(
      `SELECT o.id, o.card_id, o.status, COALESCE(s.outlet, t.outlet, 'BAR') AS outlet
         FROM orders o
         JOIN dining_tables t ON t.id = o.table_id
         LEFT JOIN table_sessions s ON s.id = o.session_id
        WHERE o.id = ?`,
    )
    .get(input.orderId) as { id: string; card_id: string | null; status: string; outlet: string } | undefined;
  if (!order || (order.status === "PAID" && !billEdit?.allowPaid) || order.status === "CANCELLED") {
    throw new AppError("Order cannot accept items");
  }

  assertOrderCardUsable(ctx, input.orderId);
  let cardTypeId: string | null = null;
  if (order.card_id) {
    const card = ctx.db.prepare("SELECT card_type_id FROM member_cards WHERE id = ?").get(order.card_id) as
      | { card_type_id: string }
      | undefined;
    cardTypeId = card?.card_type_id ?? null;
  }

  const punch = input.outlet && PUNCH_OUTLETS.has(input.outlet) ? input.outlet : order.outlet;
  const deptRate = ctx.db
    .prepare("SELECT enabled FROM product_dept_rates WHERE product_id = ? AND dept = ?")
    .get(input.productId, punch) as { enabled: number } | undefined;
  if (deptRate && !deptRate.enabled) throw new AppError("Item is not sold in this department");
  const price = resolvePrice(ctx, input.productId, cardTypeId, input.at ?? new Date(), punch);
  const notes = input.notes ?? "";
  const existing = findPendingItem(ctx, order.id, input.productId, notes);

  if (existing) {
    const next = existing.qty + input.qty;
    if (next === 0) {
      voidOrderItem(ctx, existing.id);
      return ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(existing.id);
    }
    if (next < 0) {
      // Cancel may punch AAA with blank notes after the line was given (notes)
      const served = productQty(ctx, order.id, input.productId, notes, true, false);
      if (served < -next) {
        throw new AppError(
          served <= 0 ? "This item not served on this table!" : "Cannot reduce more than ordered qty",
        );
      }
    }
    ctx.db.prepare("UPDATE order_items SET qty = ? WHERE id = ?").run(next, existing.id);
    return ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(existing.id);
  }

  if (input.qty < 0) {
    const served = productQty(ctx, order.id, input.productId, notes, true, false);
    if (served < -input.qty) {
      throw new AppError(
        served <= 0 ? "This item not served on this table!" : "Cannot reduce more than ordered qty",
      );
    }
  }

  const id = billEdit?.id ?? uuid();
  ctx.db
    .prepare(
      `INSERT INTO order_items
        (id, order_id, product_id, name, station, qty, unit_price, tax_rate, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    )
    .run(
      id,
      order.id,
      input.productId,
      price.name,
      price.station,
      input.qty,
      price.unitPrice,
      price.taxRate,
      input.notes ?? null,
    );
  return ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(id);
}

export function cancelItem(ctx: AppContext, itemId: string, reason: string) {
  assertPermission(ctx.actor.role, "VOID_KOT");
  const item = ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(itemId) as
    | { id: string; order_id: string; name: string; qty: number; kot_id: string | null; voided: number }
    | undefined;
  if (!item || item.voided) throw new AppError("Item not found");
  return ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE order_items SET voided = 1, status = 'VOID' WHERE id = ?").run(itemId);
    if (item.kot_id) {
      const kot = ctx.db.prepare("SELECT * FROM kots WHERE id = ?").get(item.kot_id) as {
        id: string;
        kot_number: string;
        station: Station;
        order_id: string;
        session_id: string;
        table_id: string;
        waiter_id: string | null;
      };
      createKot(ctx, {
        orderId: kot.order_id,
        sessionId: kot.session_id,
        tableId: kot.table_id,
        waiterId: kot.waiter_id,
        station: kot.station,
        type: "CANCEL",
        notes: reason,
        items: [{ orderItemId: item.id, productId: "", name: item.name, qty: item.qty, notes: reason }],
      });
      restoreStock(ctx, (ctx.db.prepare("SELECT product_id FROM order_items WHERE id = ?").get(itemId) as { product_id: string }).product_id, item.qty, `VOID:${item.id}`);
    }
    audit(ctx, "ITEM_CANCEL", "order_item", itemId, reason, item, { voided: true });
    syncClubCardCharge(ctx, item.order_id);
    return item;
  })();
}

function auditKotCancellation(ctx: AppContext, kotId: string, tableId: string, action: string, reason: string | null, before: unknown) {
  const table = ctx.db.prepare("SELECT code, name FROM dining_tables WHERE id = ?").get(tableId) as
    | { code: string; name: string }
    | undefined;
  const staff = ctx.db.prepare("SELECT username FROM staff WHERE id = ?").get(ctx.actor.staffId) as
    | { username: string }
    | undefined;
  audit(ctx, action, "kot", kotId, reason, before, {
    tableNo: table?.code,
    tableName: table?.name,
    username: staff?.username ?? ctx.actor.staffName,
  });
}

function createKot(
  ctx: AppContext,
  input: {
    orderId: string;
    sessionId: string;
    tableId: string;
    waiterId: string | null;
    station: Station;
    type: "NEW" | "ADDITION" | "VOID" | "CANCEL" | "MODIFICATION";
    items: Array<{ orderItemId: string; productId: string; name: string; qty: number; notes?: string | null }>;
    notes?: string;
  },
) {
  const id = uuid();
  const kotNumber = nextNumber(ctx.db, "kot", "KOT-");
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO kots
        (id, kot_number, order_id, session_id, table_id, waiter_id, station, type, status, notes, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, ?)`,
    )
    .run(
      id,
      kotNumber,
      input.orderId,
      input.sessionId,
      input.tableId,
      input.waiterId,
      input.station,
      input.type,
      input.notes ?? null,
      now,
      now,
    );
  for (const item of input.items) {
    ctx.db
      .prepare(
        `INSERT INTO kot_items (id, kot_id, order_item_id, product_id, name, qty, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(uuid(), id, item.orderItemId, item.productId, item.name, item.qty, item.notes ?? null);
    if (input.type !== "CANCEL" && input.type !== "VOID") {
      ctx.db.prepare("UPDATE order_items SET kot_id = ?, status = 'SENT' WHERE id = ?").run(id, item.orderItemId);
      if (item.productId) deductStock(ctx, item.productId, item.qty, kotNumber);
    }
  }
  if (input.type === "CANCEL") {
    auditKotCancellation(ctx, id, input.tableId, "KOT_CANCEL_SLIP", input.notes ?? null, null);
  }
  return ctx.db.prepare("SELECT * FROM kots WHERE id = ?").get(id) as {
    id: string;
    kot_number: string;
    station: Station;
    type: string;
    created_at: string;
  };
}

type SendKotOptions = { remark?: string; steward?: string; cardNumber?: string; queuePrinting?: boolean } | string;

export async function sendKot(ctx: AppContext, orderId: string, opts?: SendKotOptions) {
  const queued = typeof opts === "object" && opts.queuePrinting === true;
  const tickets = ctx.db.transaction(prepareKot)(ctx, orderId, queued, opts);
  return Promise.all(tickets.map(async ({ kot, slips, printJobIds }) => {
    if (queued) return { ...kot, printJobIds };
    const print = await printRoutedKot(ctx, kot.id, slips);
    return { ...kot, print: print.error || print.clientPrintHtml.length || print.officePrintHtml.length ? print : undefined };
  }));
}

function prepareKot(
  ctx: AppContext,
  orderId: string,
  queued: boolean,
  opts?: SendKotOptions,
) {
  assertPermission(ctx.actor.role, "SEND_KOT");
  const options = typeof opts === "string" ? { remark: opts } : opts ?? {};
  const order = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as
    | {
        id: string;
        order_number: string;
        session_id: string;
        table_id: string;
        waiter_id: string | null;
      }
    | undefined;
  if (!order) throw new AppError("Order not found", 404);
  assertOrderCardUsable(ctx, order.id);
  const punchedCard = String(options.cardNumber ?? "").trim();
  if (punchedCard) attachTableCard(ctx, order.table_id, punchedCard);
  const openOrder = order;
  const slipRemark = String(options.remark ?? "").trim();
  const stewardName = String(options.steward ?? "").trim();

  type PendingItem = {
    id: string;
    product_id: string;
    name: string;
    station: Station;
    qty: number;
    notes: string | null;
    unit_price: number;
    tax_rate: number;
    product_tax_rate: number | null;
    product_sales_group: string | null;
  };
  const pending = ctx.db
    .prepare(
      `SELECT oi.*, p.tax_rate AS product_tax_rate, p.sales_group AS product_sales_group
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? AND oi.kot_id IS NULL AND oi.voided = 0`,
    )
    .all(orderId) as PendingItem[];
  for (const item of pending) {
    item.tax_rate = displayTaxRate(ctx, {
      name: item.name,
      salesGroup: item.product_sales_group,
      productTaxRate: item.product_tax_rate,
      lineTaxRate: item.tax_rate,
    });
  }
  if (isBarOrderOnly(ctx.actor.rights) && pending.some((item) => item.qty < 0)) {
    throw new AppError("Bar orders can only add items", 403);
  }
  const additions = pending.filter((i) => i.qty > 0);
  const reductions = pending.filter((i) => i.qty < 0);
  if (!additions.length && !reductions.length) throw new AppError("No new items to send to kitchen/bar");
  syncClubCardCharge(ctx, orderId, true);

  const existingKots = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM kots WHERE session_id = ? AND type IN ('NEW','ADDITION')")
    .get(order.session_id) as { n: number };
  const kotType = existingKots.n > 0 ? "ADDITION" : "NEW";
  const table = getTable(ctx, order.table_id);
  const waiterFromStaff = order.waiter_id
    ? (ctx.db.prepare("SELECT name FROM staff WHERE id = ?").get(order.waiter_id) as { name: string } | undefined)
    : undefined;
  const steward = stewardName || waiterFromStaff?.name || "";

  const created: Array<{ kot: ReturnType<typeof createKot>; slips: ReturnType<typeof routeKot>; printJobIds?: string[] }> = [];

  function saveStationKot(
    station: Station,
    type: "NEW" | "ADDITION" | "CANCEL",
    items: Array<{
      orderItemId: string;
      productId: string;
      name: string;
      qty: number;
      notes?: string | null;
      unitPrice?: number;
      taxRate?: number;
    }>,
  ) {
    const kot = createKot(ctx, {
      orderId: openOrder.id,
      sessionId: openOrder.session_id,
      tableId: openOrder.table_id,
      waiterId: openOrder.waiter_id,
      station,
      type,
      items,
      notes: slipRemark || undefined,
    });
    const banner = type === "NEW" ? "NEW ORDER" : "RUNNING ORDER";
    const slips = routeKot(ctx, station, table.outlet, {
      kotNumber: kot.kot_number,
      tableCode: printedTableNo(ctx, { tableId: openOrder.table_id, orderId: openOrder.id }),
      waiter: steward,
      operatorName: ctx.actor.staffName,
      station,
      reprint: false,
      orderBanner: banner,
      remark: slipRemark || undefined,
      items: items.map((i) => ({
        productId: i.productId,
        qty: type === "CANCEL" ? -i.qty : i.qty,
        name: itemNameWithNotes(i.name, i.notes),
        notes: i.notes,
      })),
      createdAt: kot.created_at,
    });
    const printJobIds = queued ? slips.map((slip) => enqueueKotPrint(ctx.db, kot.id, slip)) : undefined;
    created.push({ kot, slips, printJobIds });
  }

  if (reductions.length) {
    const cancelByStation: Record<Station, Array<{
      orderItemId: string;
      productId: string;
      name: string;
      qty: number;
      notes?: string | null;
      unitPrice?: number;
      taxRate?: number;
    }>> = {
      KITCHEN: [],
      BAR: [],
    };
    for (const red of reductions) {
      let need = -red.qty;
      // Prefer same notes, but still cancel the product if notes were blank on the -qty punch
      const sent = ctx.db
        .prepare(
          `SELECT oi.*, p.tax_rate AS product_tax_rate, p.sales_group AS product_sales_group
             FROM order_items oi
             LEFT JOIN products p ON p.id = oi.product_id
            WHERE oi.order_id = ? AND oi.product_id = ? AND oi.voided = 0 AND oi.kot_id IS NOT NULL
            ORDER BY CASE WHEN IFNULL(oi.notes,'') = ? THEN 0 ELSE 1 END, oi.rowid`,
        )
        .all(orderId, red.product_id, red.notes ?? "") as Array<{
        id: string;
        product_id: string;
        name: string;
        station: Station;
        qty: number;
        notes: string | null;
        unit_price: number;
        tax_rate: number;
        product_tax_rate: number | null;
        product_sales_group: string | null;
      }>;
      for (const item of sent) {
        if (need <= 0) break;
        const take = Math.min(item.qty, need);
        if (take === item.qty) voidOrderItem(ctx, item.id);
        else ctx.db.prepare("UPDATE order_items SET qty = qty - ? WHERE id = ?").run(take, item.id);
        restoreStock(ctx, item.product_id, take, `CXL:${red.id}`);
        cancelByStation[item.station].push({
          orderItemId: item.id,
          productId: item.product_id,
          name: item.name,
          qty: take,
          notes: item.notes,
          unitPrice: item.unit_price,
          taxRate: displayTaxRate(ctx, {
            name: item.name,
            salesGroup: item.product_sales_group,
            productTaxRate: item.product_tax_rate,
            lineTaxRate: item.tax_rate,
          }),
        });
        need -= take;
      }
      if (need > 0) {
        throw new AppError(
          cancelByStation.KITCHEN.length + cancelByStation.BAR.length === 0
            ? "This item not served on this table!"
            : "Cannot reduce more than ordered qty",
        );
      }
      voidOrderItem(ctx, red.id);
    }
    for (const station of ["KITCHEN", "BAR"] as Station[]) {
      const items = cancelByStation[station];
      if (!items.length) continue;
      // One punch of -2 must print as one struck line (qty -2), not two -1 rows
      // from separate earlier KOT lines of the same item.
      const merged = new Map<string, (typeof items)[number]>();
      for (const it of items) {
        const key = `${it.productId}|${it.notes ?? ""}|${it.name}`;
        const cur = merged.get(key);
        if (cur) cur.qty += it.qty;
        else merged.set(key, { ...it });
      }
      saveStationKot(station, "CANCEL", [...merged.values()]);
    }
  }

  for (const station of ["KITCHEN", "BAR"] as Station[]) {
    const items = additions.filter((i) => i.station === station);
    if (!items.length) continue;
    saveStationKot(
      station,
      kotType,
      items.map((i) => ({
        orderItemId: i.id,
        productId: i.product_id,
        name: i.name,
        qty: i.qty,
        notes: i.notes,
        unitPrice: i.unit_price,
        taxRate: i.tax_rate,
      })),
    );
  }

  audit(ctx, "KOT_SEND", "order", orderId, null, null, created.map(({ kot }) => kot.kot_number));
  return created;
}

/** Display name on KOT / UI: ITEM (notes). */
export function itemNameWithNotes(name: string, notes?: string | null): string {
  const n = String(notes ?? "").trim();
  return n ? `${name} (${n})` : name;
}

/** Per-line kitchen note before Print KOT (double-click on punch row). */
export function setItemNotes(ctx: AppContext, itemId: string, notes: string) {
  const item = ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(itemId) as
    | {
        id: string;
        name: string;
        notes: string | null;
        kot_id: string | null;
        voided: number;
      }
    | undefined;
  if (!item || item.voided) throw new AppError("Item not found");
  if (item.kot_id) throw new AppError("Item already sent on KOT");
  const cleaned = String(notes ?? "").trim().slice(0, 80);
  ctx.db.prepare("UPDATE order_items SET notes = ? WHERE id = ?").run(cleaned || null, item.id);
  audit(ctx, "ITEM_NOTES", "order_item", item.id, null, item.notes, cleaned || null);
  return ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(item.id);
}

export function modifyItemQty(ctx: AppContext, itemId: string, newQty: number) {
  if (!Number.isInteger(newQty) || newQty <= 0) throw new AppError("Quantity must be a positive integer");
  const item = ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(itemId) as
    | {
        id: string;
        order_id: string;
        product_id: string;
        name: string;
        station: Station;
        qty: number;
        notes: string | null;
        kot_id: string | null;
        voided: number;
      }
    | undefined;
  if (!item || item.voided) throw new AppError("Item not found");
  assertOrderCardUsable(ctx, item.order_id);
  if (newQty === item.qty) return item;
  if (!item.kot_id) {
    ctx.db.prepare("UPDATE order_items SET qty = ? WHERE id = ?").run(newQty, item.id);
    return ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(item.id);
  }
  if (newQty < item.qty) throw new AppError("Reduce quantity via cancel item after KOT is sent");
  const added = newQty - item.qty;
  return ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE order_items SET qty = ? WHERE id = ?").run(newQty, item.id);
    const order = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(item.order_id) as {
      id: string;
      session_id: string;
      table_id: string;
      waiter_id: string | null;
    };
    const kot = createKot(ctx, {
      orderId: order.id,
      sessionId: order.session_id,
      tableId: order.table_id,
      waiterId: order.waiter_id,
      station: item.station,
      type: "ADDITION",
      items: [
        {
          orderItemId: item.id,
          productId: item.product_id,
          name: item.name,
          qty: added,
          notes: item.notes,
        },
      ],
    });
    audit(ctx, "KOT_ADDITION", "order_item", item.id, null, item.qty, newQty);
    syncClubCardCharge(ctx, item.order_id, true);
    return { item: ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(item.id), kot };
  })();
}

/** Sets the billed quantity of a line without printing a KOT. Qty 0 removes the line. */
export function setBillLineQty(ctx: AppContext, orderId: string, ids: string[], qty: number, billEdit?: { allowPaid: boolean }) {
  assertPermission(ctx.actor.role, "CREATE_ORDER");
  assertOrderCardUsable(ctx, orderId);
  if (!Number.isInteger(qty) || qty < 0) throw new AppError("Quantity must be a whole number");
  const order = ctx.db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as { status: string } | undefined;
  if (!order || (order.status === "PAID" && !billEdit?.allowPaid) || order.status === "CANCELLED") throw new AppError("Bill cannot be changed");
  const items = ids
    .map((id) => ctx.db.prepare("SELECT * FROM order_items WHERE id = ? AND order_id = ? AND voided = 0").get(id, orderId) as
      | { id: string; product_id: string; qty: number; kot_id: string | null }
      | undefined)
    .filter((row): row is { id: string; product_id: string; qty: number; kot_id: string | null } => !!row);
  if (!items.length) throw new AppError("Item not found");
  const sum = items.reduce((total, item) => total + item.qty, 0);
  if (qty === sum) return { qty };

  return ctx.db.transaction(() => {
  function apply(item: { id: string; product_id: string; qty: number; kot_id: string | null }, next: number) {
    const delta = next - item.qty;
    if (item.kot_id && delta > 0) deductStock(ctx, item.product_id, delta, `BILL:${item.id}`);
    if (item.kot_id && delta < 0) restoreStock(ctx, item.product_id, -delta, `BILL:${item.id}`);
    if (next <= 0) ctx.db.prepare("UPDATE order_items SET qty = 0, voided = 1, status = 'VOID' WHERE id = ?").run(item.id);
    else ctx.db.prepare("UPDATE order_items SET qty = ? WHERE id = ?").run(next, item.id);
  }

  if (qty > sum) {
    const last = items[items.length - 1];
    apply(last, last.qty + (qty - sum));
  } else {
    let left = sum - qty;
    for (let i = items.length - 1; i >= 0 && left > 0; i--) {
      const take = Math.min(items[i].qty, left);
      apply(items[i], items[i].qty - take);
      left -= take;
    }
  }
  audit(ctx, "BILL_QTY", "order", orderId, null, sum, qty);
  if (!billEdit) syncClubCardCharge(ctx, orderId);
  return { qty };
  })();
}

/** Replaces the product on a bill line and keeps the quantity. Does not print a KOT. */
export function setBillLineProduct(ctx: AppContext, orderId: string, ids: string[], productId: string, outlet?: string, billEdit?: { allowPaid: boolean }) {
  assertPermission(ctx.actor.role, "CREATE_ORDER");
  assertOrderCardUsable(ctx, orderId);
  const order = ctx.db
    .prepare(
      `SELECT o.id, o.card_id, o.status, COALESCE(s.outlet, t.outlet, 'BAR') AS outlet
         FROM orders o
         JOIN dining_tables t ON t.id = o.table_id
         LEFT JOIN table_sessions s ON s.id = o.session_id
        WHERE o.id = ?`,
    )
    .get(orderId) as { id: string; card_id: string | null; status: string; outlet: string } | undefined;
  if (!order || (order.status === "PAID" && !billEdit?.allowPaid) || order.status === "CANCELLED") throw new AppError("Bill cannot be changed");
  const items = ids
    .map((id) => ctx.db.prepare("SELECT * FROM order_items WHERE id = ? AND order_id = ? AND voided = 0").get(id, orderId) as
      | { id: string; product_id: string; qty: number; kot_id: string | null }
      | undefined)
    .filter((row): row is { id: string; product_id: string; qty: number; kot_id: string | null } => !!row);
  if (!items.length) throw new AppError("Item not found");
  if (!productId) throw new AppError("Select an item");
  if (items.every((item) => item.product_id === productId)) return { id: items[0].id };

  return ctx.db.transaction(() => {
  let cardTypeId: string | null = null;
  if (order.card_id) {
    const card = ctx.db.prepare("SELECT card_type_id FROM member_cards WHERE id = ?").get(order.card_id) as
      | { card_type_id: string }
      | undefined;
    cardTypeId = card?.card_type_id ?? null;
  }
  const punch = outlet && PUNCH_OUTLETS.has(outlet) ? outlet : order.outlet;
  const deptRate = ctx.db
    .prepare("SELECT enabled FROM product_dept_rates WHERE product_id = ? AND dept = ?")
    .get(productId, punch) as { enabled: number } | undefined;
  if (deptRate && !deptRate.enabled) throw new AppError("Item is not sold in this department");
  const price = resolvePrice(ctx, productId, cardTypeId, new Date(), punch);
  const sum = items.reduce((total, item) => total + item.qty, 0);
  let sent = 0;
  for (const item of items) {
    if (!item.kot_id) continue;
    restoreStock(ctx, item.product_id, item.qty, `BILL:${item.id}`);
    sent += item.qty;
  }
  const first = items[0];
  ctx.db
    .prepare(
      `UPDATE order_items
          SET product_id = ?, name = ?, station = ?, qty = ?, unit_price = ?, tax_rate = ?
        WHERE id = ?`,
    )
    .run(productId, price.name, price.station, sum, price.unitPrice, price.taxRate, first.id);
  if (sent > 0) deductStock(ctx, productId, sent, `BILL:${first.id}`);
  for (const extra of items.slice(1)) {
    ctx.db.prepare("UPDATE order_items SET qty = 0, voided = 1, status = 'VOID' WHERE id = ?").run(extra.id);
  }
  audit(ctx, "BILL_ITEM", "order", orderId, null, items.map((item) => item.product_id), productId);
  if (!billEdit) syncClubCardCharge(ctx, orderId);
  return ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(first.id);
  })();
}

/** Sets the billed price of a line, in paise, without printing a KOT. */
export function setBillLinePrice(ctx: AppContext, orderId: string, ids: string[], unitPrice: number, billEdit?: { allowPaid: boolean }) {
  if (ctx.actor.userGroup === "CASHIER") throw new AppError("Cashier users cannot change bill item prices", 403);
  assertPermission(ctx.actor.role, "CREATE_ORDER");
  assertOrderCardUsable(ctx, orderId);
  if (!Number.isInteger(unitPrice) || unitPrice < 0) throw new AppError("Enter a price");
  const order = ctx.db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as { status: string } | undefined;
  if (!order || (order.status === "PAID" && !billEdit?.allowPaid) || order.status === "CANCELLED") throw new AppError("Bill cannot be changed");
  const items = ids
    .map((id) => ctx.db.prepare("SELECT id, unit_price FROM order_items WHERE id = ? AND order_id = ? AND voided = 0").get(id, orderId) as
      | { id: string; unit_price: number }
      | undefined)
    .filter((row): row is { id: string; unit_price: number } => !!row);
  if (!items.length) throw new AppError("Item not found");
  if (items.every((item) => item.unit_price === unitPrice)) return { unitPrice };
  const before = items[0].unit_price;
  return ctx.db.transaction(() => {
    for (const item of items) {
      ctx.db.prepare("UPDATE order_items SET unit_price = ? WHERE id = ?").run(unitPrice, item.id);
    }
    audit(ctx, "BILL_PRICE", "order", orderId, null, before, unitPrice);
    if (!billEdit) syncClubCardCharge(ctx, orderId);
    return { unitPrice };
  })();
}

function routeKot(
  ctx: AppContext,
  station: Station,
  outlet: string | undefined,
  payload: Omit<KotPrintPayload, "items"> & {
    items: Array<KotPrintPayload["items"][number] & { productId: string }>;
  },
) {
  type Destination = keyof ReturnType<typeof kotPrinters> | "CONNECTED" | "OFFICE LOCAL";
  const lookup = ctx.db.prepare("SELECT item_group FROM products WHERE id = ?");
  const jobs = new Map<Destination, KotPrintPayload["items"]>();
  const localOutlet = outlet === "THE BOSS CLUB" || outlet === "RESTAURANT";
  for (const { productId, ...item } of payload.items) {
    const product = lookup.get(productId) as { item_group: string | null } | undefined;
    const group = product?.item_group?.trim().toUpperCase();
    let destination: Destination = station;
    if (localOutlet) {
      const food = group === "FOOD" || group === "EV FOOD" || (!group && station === "KITCHEN");
      destination = food ? "KITCHEN" : "CONNECTED";
    } else switch (group) {
      case "FOOD":
      case "EV FOOD":
        destination = "KITCHEN";
        break;
      case "BAR":
        destination = "BAR";
        break;
      case "BEVERAGE":
      case "CAFE":
      case "EV CAFE":
        destination = "CAFE BAR";
        break;
      case "SPL":
        if (!ctx.officeTerminal) continue;
        destination = "OFFICE LOCAL";
        break;
      case "SPL1":
        destination = "CONNECTED";
        break;
    }
    const items = jobs.get(destination) ?? [];
    items.push(item);
    jobs.set(destination, items);
  }
  const slips = Array.from(jobs, ([destination, items]) => ({ ...payload, station: destination, items }));
  if (localOutlet) {
    const items = payload.items.map(({ productId, ...item }) => item);
    slips.push({ ...payload, station: "CONNECTED", customerCopy: true, items });
  }
  return slips;
}

async function printRoutedKot(ctx: AppContext, kotId: string, slips: ReturnType<typeof routeKot>) {
  const printers = kotPrinters(ctx.hardware);
  const errors: string[] = [];
  const clientPrintHtml: string[] = [];
  const officePrintHtml: string[] = [];
  for (const slip of slips) {
    const destination = slip.station;
    if (destination === "CONNECTED" || destination === "OFFICE LOCAL") {
      const html = formatKotHtml(slip);
      if (destination === "OFFICE LOCAL") officePrintHtml.push(html);
      else clientPrintHtml.push(html);
      continue;
    }
    const printer = printers[destination];
    const result = printer ? await printer.printKOT(slip) : { ok: false, error: "Printer queue is not configured" };
    if (!result.ok) {
      const error = result.error ?? "print failed";
      errors.push(`${destination}: ${error}`);
      audit(ctx, "PRINTER_FAILURE", "kot", kotId, error, null, { station: destination, kot: slip.kotNumber });
    }
  }
  return { ok: !errors.length, error: errors.length ? errors.join(", ") : undefined, clientPrintHtml, officePrintHtml };
}

export async function reprintKot(ctx: AppContext, kotId: string) {
  const kot = ctx.db.prepare("SELECT * FROM kots WHERE id = ?").get(kotId) as
    | {
        id: string;
        kot_number: string;
        order_id: string;
        table_id: string;
        station: Station;
        type: string;
        waiter_id: string | null;
        notes: string | null;
        created_at: string;
      }
    | undefined;
  if (!kot) throw new AppError("KOT not found", 404);
  const items = ctx.db
    .prepare(`SELECT qty, name, notes, product_id FROM kot_items WHERE kot_id = ?`)
    .all(kotId) as Array<{ qty: number; name: string; notes: string | null; product_id: string }>;
  const table = getTable(ctx, kot.table_id);
  const waiter = kot.waiter_id
    ? (ctx.db.prepare("SELECT name FROM staff WHERE id = ?").get(kot.waiter_id) as { name: string } | undefined)
    : undefined;
  ctx.db.prepare("UPDATE kots SET reprint_count = reprint_count + 1 WHERE id = ?").run(kotId);
  ctx.db
    .prepare("INSERT INTO kot_reprints (id, kot_id, staff_id, created_at) VALUES (?, ?, ?, ?)")
    .run(uuid(), kotId, ctx.actor.staffId, nowIso());
  audit(ctx, "KOT_REPRINT", "kot", kotId, "*** REPRINT ***", null, kot.kot_number);
  const print = await printRoutedKot(ctx, kotId, routeKot(ctx, kot.station, table.outlet, {
    kotNumber: kot.kot_number,
    tableCode: printedTableNo(ctx, { tableId: kot.table_id, orderId: kot.order_id }),
    waiter: waiter?.name,
    operatorName: ctx.actor.staffName,
    station: kot.station,
    reprint: true,
    orderBanner: kot.type === "NEW" ? "NEW ORDER" : "RUNNING ORDER",
    remark: kot.notes,
    items: items.map((i) => ({
      productId: i.product_id,
      qty: i.qty,
      name: itemNameWithNotes(i.name, i.notes),
      notes: i.notes,
    })),
    createdAt: kot.created_at,
  }));
  return { ...print, reprint: true };
}

export function advanceKot(ctx: AppContext, kotId: string, status: KotStatus, reason = "void") {
  const kot = ctx.db.prepare("SELECT * FROM kots WHERE id = ?").get(kotId) as
    | { id: string; status: KotStatus; station: Station; table_id: string }
    | undefined;
  if (!kot) throw new AppError("KOT not found", 404);
  const permission = kot.station === "BAR" ? "KDS_BAR" : "KDS_KITCHEN";
  assertPermission(ctx.actor.role, permission);
  if (status === "VOID") {
    assertPermission(ctx.actor.role, "VOID_KOT");
    if (kot.status === "VOID") return kot;
  }
  const now = nowIso();
  const fields: Record<KotStatus, string | null> = {
    NEW: null,
    SENT: "sent_at",
    ACCEPTED: "accepted_at",
    PREPARING: "preparing_at",
    READY: "ready_at",
    SERVED: "served_at",
    VOID: "voided_at",
  };
  const ts = fields[status];
  if (ts) {
    ctx.db.prepare(`UPDATE kots SET status = ?, ${ts} = COALESCE(${ts}, ?) WHERE id = ?`).run(status, now, kotId);
  } else {
    ctx.db.prepare("UPDATE kots SET status = ? WHERE id = ?").run(status, kotId);
  }
  if (status === "VOID") {
    auditKotCancellation(ctx, kotId, kot.table_id, "KOT_CANCEL", reason, kot.status);
  }
  return ctx.db.prepare("SELECT * FROM kots WHERE id = ?").get(kotId);
}

export function voidKot(ctx: AppContext, kotId: string, reason: string) {
  assertPermission(ctx.actor.role, "VOID_KOT");
  const items = ctx.db.prepare("SELECT * FROM kot_items WHERE kot_id = ?").all(kotId) as Array<{
    order_item_id: string;
    product_id: string;
    qty: number;
  }>;
  return ctx.db.transaction(() => {
    const kot = ctx.db.prepare("SELECT * FROM kots WHERE id = ?").get(kotId) as
      | { order_id: string; status: KotStatus }
      | undefined;
    if (!kot) throw new AppError("KOT not found", 404);
    if (kot.status === "VOID") return advanceKot(ctx, kotId, "VOID", reason);
    for (const item of items) {
      ctx.db.prepare("UPDATE order_items SET voided = 1, status = 'VOID' WHERE id = ?").run(item.order_item_id);
      if (item.product_id) restoreStock(ctx, item.product_id, item.qty, `KOTVOID:${kotId}`);
    }
    const result = advanceKot(ctx, kotId, "VOID", reason);
    syncClubCardCharge(ctx, kot.order_id);
    return result;
  })();
}

export function listKots(ctx: AppContext, station?: Station) {
  const sql = `
    SELECT k.*, t.code AS table_code,
           COALESCE(NULLIF(t.outlet, ''), 'BAR') AS outlet_name,
           (
             SELECT c.card_number FROM member_cards c
              WHERE c.id = COALESCE(
                o.card_id,
                (SELECT s2.card_id FROM table_sessions s2 WHERE s2.id = k.session_id)
              )
           ) AS order_card,
           o.order_number, s.name AS waiter_name
    FROM kots k
    JOIN dining_tables t ON t.id = k.table_id
    JOIN orders o ON o.id = k.order_id
    LEFT JOIN staff s ON s.id = k.waiter_id
    ${station ? "WHERE k.station = ?" : ""}
    ORDER BY k.created_at DESC
  `;
  const kots = (station ? ctx.db.prepare(sql).all(station) : ctx.db.prepare(sql).all()) as Array<{
    id: string;
    table_code: string;
    outlet_name: string;
    order_card: string | null;
  }>;
  return kots.map((k) => ({
    ...k,
    table_label: formatTableNo(k.table_code, k.order_card, k.outlet_name),
    items: ctx.db.prepare("SELECT * FROM kot_items WHERE kot_id = ?").all(k.id),
  }));
}

export function listOrders(ctx: AppContext) {
  const rows = ctx.db
    .prepare(
      `SELECT o.*, t.code AS table_code,
              COALESCE(NULLIF(t.outlet, ''), 'BAR') AS outlet_name,
              (
                SELECT c.card_number FROM member_cards c
                 WHERE c.id = COALESCE(
                   o.card_id,
                   (SELECT s.card_id FROM table_sessions s WHERE s.id = o.session_id)
                 )
              ) AS order_card,
              (SELECT COALESCE(SUM(qty * unit_price),0) FROM order_items WHERE order_id = o.id AND voided = 0) AS total
       FROM orders o
       JOIN dining_tables t ON t.id = o.table_id
       ORDER BY o.created_at DESC`,
    )
    .all() as Array<{ table_code: string; outlet_name: string; order_card: string | null }>;
  return rows.map((row) => ({
    ...row,
    table_label: formatTableNo(row.table_code, row.order_card, row.outlet_name),
  }));
}

export function getOrderDetail(ctx: AppContext, orderId: string) {
  const order = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) throw new AppError("Order not found", 404);
  const items = ctx.db
    .prepare(
      `SELECT oi.*, p.sku
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? AND oi.voided = 0
        ORDER BY oi.rowid`,
    )
    .all(orderId);
  const kots = ctx.db
    .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at DESC")
    .all(orderId);
  return { order, items, kots };
}
