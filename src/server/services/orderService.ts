import { assertPermission } from "../../shared/permissions.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { nextNumber, nowIso, uuid } from "../lib/ids.js";
import { printerForStation } from "../hardware/index.js";
import { deductStock, restoreStock } from "./inventoryService.js";
import { resolvePrice } from "./pricingService.js";
import { getTable } from "./tableService.js";
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
  if (existing) return existing;

  const session = ctx.db
    .prepare("SELECT * FROM table_sessions WHERE id = ?")
    .get(table.current_session_id) as {
    customer_id: string | null;
    card_id: string | null;
    waiter_id: string | null;
  };

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

export function addItem(
  ctx: AppContext,
  input: { orderId: string; productId: string; qty: number; notes?: string; at?: Date },
) {
  assertPermission(ctx.actor.role, "CREATE_ORDER");
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new AppError("Quantity must be a positive integer");
  const order = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(input.orderId) as
    | { id: string; card_id: string | null; status: string }
    | undefined;
  if (!order || order.status === "PAID" || order.status === "CANCELLED") {
    throw new AppError("Order cannot accept items");
  }

  let cardTypeId: string | null = null;
  if (order.card_id) {
    const card = ctx.db.prepare("SELECT card_type_id FROM member_cards WHERE id = ?").get(order.card_id) as
      | { card_type_id: string }
      | undefined;
    cardTypeId = card?.card_type_id ?? null;
  }

  const price = resolvePrice(ctx, input.productId, cardTypeId, input.at ?? new Date());
  const existing = ctx.db
    .prepare(
      `SELECT * FROM order_items
       WHERE order_id = ? AND product_id = ? AND IFNULL(notes,'') = ? AND kot_id IS NULL AND voided = 0`,
    )
    .get(order.id, input.productId, input.notes ?? "") as { id: string; qty: number } | undefined;

  if (existing) {
    ctx.db.prepare("UPDATE order_items SET qty = qty + ? WHERE id = ?").run(input.qty, existing.id);
    return ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(existing.id);
  }

  const id = uuid();
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
      items: [{ orderItemId: item.id, productId: "", name: item.name, qty: item.qty, notes: reason }],
    });
    restoreStock(ctx, (ctx.db.prepare("SELECT product_id FROM order_items WHERE id = ?").get(itemId) as { product_id: string }).product_id, item.qty, `VOID:${item.id}`);
  }
  audit(ctx, "ITEM_CANCEL", "order_item", itemId, reason, item, { voided: true });
  return item;
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
  return ctx.db.prepare("SELECT * FROM kots WHERE id = ?").get(id) as {
    id: string;
    kot_number: string;
    station: Station;
    type: string;
    created_at: string;
  };
}

export async function sendKot(ctx: AppContext, orderId: string) {
  assertPermission(ctx.actor.role, "SEND_KOT");
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

  const pending = ctx.db
    .prepare("SELECT * FROM order_items WHERE order_id = ? AND kot_id IS NULL AND voided = 0")
    .all(orderId) as Array<{
    id: string;
    product_id: string;
    name: string;
    station: Station;
    qty: number;
    notes: string | null;
  }>;
  if (!pending.length) throw new AppError("No new items to send to kitchen/bar");

  const existingKots = ctx.db.prepare("SELECT COUNT(*) AS n FROM kots WHERE order_id = ? AND type IN ('NEW','ADDITION')").get(orderId) as {
    n: number;
  };
  const kotType = existingKots.n > 0 ? "ADDITION" : "NEW";
  const table = getTable(ctx, order.table_id);
  const waiter = order.waiter_id
    ? (ctx.db.prepare("SELECT name FROM staff WHERE id = ?").get(order.waiter_id) as { name: string } | undefined)
    : undefined;

  const created = [];
  for (const station of ["KITCHEN", "BAR"] as Station[]) {
    const items = pending.filter((i) => i.station === station);
    if (!items.length) continue;
    const kot = createKot(ctx, {
      orderId: order.id,
      sessionId: order.session_id,
      tableId: order.table_id,
      waiterId: order.waiter_id,
      station,
      type: kotType,
      items: items.map((i) => ({
        orderItemId: i.id,
        productId: i.product_id,
        name: i.name,
        qty: i.qty,
        notes: i.notes,
      })),
    });
    created.push(kot);
    const print = await printerForStation(ctx.hardware, station).printKOT({
      kotNumber: kot.kot_number,
      tableCode: table.code,
      waiter: waiter?.name,
      station,
      reprint: false,
      items: items.map((i) => ({ qty: i.qty, name: i.name, notes: i.notes })),
      createdAt: kot.created_at,
    });
    if (!print.ok) {
      audit(ctx, "PRINTER_FAILURE", "kot", kot.id, print.error ?? "print failed", null, {
        station,
        kot: kot.kot_number,
      });
    }
  }

  audit(ctx, "KOT_SEND", "order", orderId, null, null, created.map((k) => k.kot_number));
  return created;
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
  if (newQty === item.qty) return item;
  if (!item.kot_id) {
    ctx.db.prepare("UPDATE order_items SET qty = ? WHERE id = ?").run(newQty, item.id);
    return ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(item.id);
  }
  if (newQty < item.qty) throw new AppError("Reduce quantity via cancel item after KOT is sent");
  const added = newQty - item.qty;
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
  return { item: ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(item.id), kot };
}

export async function reprintKot(ctx: AppContext, kotId: string) {
  const kot = ctx.db.prepare("SELECT * FROM kots WHERE id = ?").get(kotId) as
    | {
        id: string;
        kot_number: string;
        table_id: string;
        station: Station;
        waiter_id: string | null;
        created_at: string;
      }
    | undefined;
  if (!kot) throw new AppError("KOT not found", 404);
  const items = ctx.db.prepare("SELECT qty, name, notes FROM kot_items WHERE kot_id = ?").all(kotId) as Array<{
    qty: number;
    name: string;
    notes: string | null;
  }>;
  const table = getTable(ctx, kot.table_id);
  const waiter = kot.waiter_id
    ? (ctx.db.prepare("SELECT name FROM staff WHERE id = ?").get(kot.waiter_id) as { name: string } | undefined)
    : undefined;
  ctx.db.prepare("UPDATE kots SET reprint_count = reprint_count + 1 WHERE id = ?").run(kotId);
  ctx.db
    .prepare("INSERT INTO kot_reprints (id, kot_id, staff_id, created_at) VALUES (?, ?, ?, ?)")
    .run(uuid(), kotId, ctx.actor.staffId, nowIso());
  audit(ctx, "KOT_REPRINT", "kot", kotId, "*** REPRINT ***", null, kot.kot_number);
  const print = await printerForStation(ctx.hardware, kot.station).printKOT({
    kotNumber: kot.kot_number,
    tableCode: table.code,
    waiter: waiter?.name,
    station: kot.station,
    reprint: true,
    items,
    createdAt: kot.created_at,
  });
  return { ok: print.ok, error: print.error, reprint: true };
}

export function advanceKot(ctx: AppContext, kotId: string, status: KotStatus) {
  const kot = ctx.db.prepare("SELECT * FROM kots WHERE id = ?").get(kotId) as
    | { id: string; status: KotStatus; station: Station }
    | undefined;
  if (!kot) throw new AppError("KOT not found", 404);
  const permission = kot.station === "BAR" ? "KDS_BAR" : "KDS_KITCHEN";
  assertPermission(ctx.actor.role, permission);
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
    assertPermission(ctx.actor.role, "VOID_KOT");
    audit(ctx, "KOT_CANCEL", "kot", kotId, "void", kot.status, "VOID");
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
  for (const item of items) {
    ctx.db.prepare("UPDATE order_items SET voided = 1, status = 'VOID' WHERE id = ?").run(item.order_item_id);
    if (item.product_id) restoreStock(ctx, item.product_id, item.qty, `KOTVOID:${kotId}`);
  }
  const result = advanceKot(ctx, kotId, "VOID");
  audit(ctx, "KOT_CANCEL", "kot", kotId, reason, null, "VOID");
  return result;
}

export function listKots(ctx: AppContext, station?: Station) {
  const sql = `
    SELECT k.*, t.code AS table_code, o.order_number, s.name AS waiter_name
    FROM kots k
    JOIN dining_tables t ON t.id = k.table_id
    JOIN orders o ON o.id = k.order_id
    LEFT JOIN staff s ON s.id = k.waiter_id
    ${station ? "WHERE k.station = ?" : ""}
    ORDER BY k.created_at DESC
  `;
  const kots = (station ? ctx.db.prepare(sql).all(station) : ctx.db.prepare(sql).all()) as Array<{
    id: string;
  }>;
  return kots.map((k) => ({
    ...k,
    items: ctx.db.prepare("SELECT * FROM kot_items WHERE kot_id = ?").all(k.id),
  }));
}

export function listOrders(ctx: AppContext) {
  return ctx.db
    .prepare(
      `SELECT o.*, t.code AS table_code,
              (SELECT COALESCE(SUM(qty * unit_price),0) FROM order_items WHERE order_id = o.id AND voided = 0) AS total
       FROM orders o
       JOIN dining_tables t ON t.id = o.table_id
       ORDER BY o.created_at DESC`,
    )
    .all();
}

export function getOrderDetail(ctx: AppContext, orderId: string) {
  const order = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) throw new AppError("Order not found", 404);
  const items = ctx.db.prepare("SELECT * FROM order_items WHERE order_id = ? AND voided = 0").all(orderId);
  const kots = listKots(ctx).filter((k) => (k as unknown as { order_id: string }).order_id === orderId);
  return { order, items, kots };
}
