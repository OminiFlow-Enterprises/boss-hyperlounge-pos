import { assertPermission } from "../../shared/permissions.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { businessDayStart, nextNumber, nowIso, uuid } from "../lib/ids.js";
import type { ServiceChargeMode, SplitType, TableStatus } from "../../shared/types.js";
import { previewBill } from "./billingService.js";
import { dayCloseHour } from "./settingsService.js";

export function listFloors(ctx: AppContext) {
  return ctx.db.prepare("SELECT * FROM floors ORDER BY sort_order, name").all();
}

export function closeStaleDaySessions(ctx: AppContext) {
  const cutoff = businessDayStart(new Date(), dayCloseHour(ctx)).toISOString();
  const stale = ctx.db
    .prepare(
      `SELECT t.id FROM dining_tables t
       JOIN table_sessions s ON s.id = t.current_session_id
       WHERE s.opened_at < ? AND t.status != 'AVAILABLE'`,
    )
    .all(cutoff) as Array<{ id: string }>;
  for (const row of stale) closeTable(ctx, row.id);
  return stale.length;
}

export function listTables(ctx: AppContext) {
  closeStaleDaySessions(ctx);
  const cutoff = businessDayStart(new Date(), dayCloseHour(ctx)).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT t.*, f.name AS floor_name, s.customer_id, s.card_id, s.waiter_id, s.id AS session_id,
              s.opened_at AS session_opened_at, cu.name AS customer_name, c.card_number, st.name AS waiter_name,
              CASE WHEN t.current_session_id IS NULL THEN 0 ELSE (
                SELECT COALESCE(SUM(oi.qty * oi.unit_price), 0)
                  FROM orders o JOIN order_items oi ON oi.order_id = o.id
                 WHERE o.session_id = t.current_session_id AND oi.voided = 0
                   AND o.created_at >= ?
              ) END AS running_total
       FROM dining_tables t
       JOIN floors f ON f.id = t.floor_id
       LEFT JOIN table_sessions s ON s.id = t.current_session_id
       LEFT JOIN customers cu ON cu.id = s.customer_id
       LEFT JOIN member_cards c ON c.id = s.card_id
       LEFT JOIN staff st ON st.id = s.waiter_id
       ORDER BY f.sort_order, t.code`,
    )
    .all(cutoff) as Array<Record<string, unknown>>;
  return withNetTotals(ctx, rows);
}

function withNetTotals(ctx: AppContext, rows: Array<Record<string, unknown>>) {
  const orderStmt = ctx.db.prepare(
    `SELECT id FROM orders
      WHERE session_id = ? AND status IN ('OPEN','BILL_REQUESTED','SETTLING')
      ORDER BY created_at DESC LIMIT 1`,
  );
  const invoiceStmt = ctx.db.prepare(
    `SELECT discount, service_charge_pct, service_charge_mode, other_charges
       FROM invoices
      WHERE order_id = ? AND status IN ('UNPAID','PARTIAL')
      ORDER BY created_at DESC LIMIT 1`,
  );
  for (const row of rows) {
    const sessionId = row.current_session_id as string | null;
    const running = Number(row.running_total) || 0;
    if (!sessionId) {
      row.net_total = 0;
      continue;
    }
    const order = orderStmt.get(sessionId) as { id: string } | undefined;
    if (!order) {
      row.net_total = running;
      continue;
    }
    const inv = invoiceStmt.get(order.id) as
      | { discount: number; service_charge_pct: number; service_charge_mode: string; other_charges: number }
      | undefined;
    try {
      const savedPct = Number(inv?.service_charge_pct) || 0;
      const bill = previewBill(
        ctx,
        order.id,
        inv
          ? {
              discount: Number(inv.discount) || 0,
              discountFrom: "amount",
              // Prefer saved %; if old bill stored 0, fall through to settings default (10)
              ...(savedPct > 0
                ? {
                    serviceChargePct: savedPct,
                    serviceChargeMode: (inv.service_charge_mode || "EXCLUSIVE") as ServiceChargeMode,
                  }
                : {}),
              otherCharges: Number(inv.other_charges) || 0,
            }
          : {},
      );
      row.net_total = bill.grandTotal;
    } catch {
      row.net_total = running;
    }
  }
  return rows;
}

export function findTableByCode(ctx: AppContext, code: string, outlet?: string) {
  const raw = code.trim();
  if (outlet) {
    return ctx.db
      .prepare("SELECT * FROM dining_tables WHERE lower(code) = lower(?) AND outlet = ?")
      .get(raw, outlet) as
      | {
          id: string;
          code: string;
          status: TableStatus;
          current_session_id: string | null;
          floor_id: string;
          outlet: string;
        }
      | undefined;
  }
  return ctx.db.prepare("SELECT * FROM dining_tables WHERE lower(code) = lower(?)").get(raw) as
    | {
        id: string;
        code: string;
        status: TableStatus;
        current_session_id: string | null;
        floor_id: string;
        outlet: string;
      }
    | undefined;
}

export function getTableByCode(ctx: AppContext, code: string, outlet?: string) {
  const row = findTableByCode(ctx, code, outlet);
  if (!row) throw new AppError(`Table ${code} not found`, 404);
  return row;
}

export function createTable(
  ctx: AppContext,
  input: { code: string; name?: string; floorId?: string; capacity?: number; outlet?: string },
) {
  assertPermission(ctx.actor.role, "CREATE_ORDER");
  const code = input.code.trim();
  if (!code) throw new AppError("Table code is required");
  const outlet = input.outlet?.trim() || "BAR";
  const existing = findTableByCode(ctx, code, outlet);
  if (existing) return getTable(ctx, existing.id);
  const floor =
    (input.floorId && (ctx.db.prepare("SELECT id FROM floors WHERE id = ?").get(input.floorId) as { id: string } | undefined)) ||
    (ctx.db.prepare("SELECT id FROM floors ORDER BY sort_order, name LIMIT 1").get() as { id: string } | undefined);
  if (!floor) throw new AppError("No floor configured");
  const id = uuid();
  try {
    ctx.db
      .prepare(
        "INSERT INTO dining_tables (id, floor_id, code, name, capacity, status, outlet) VALUES (?, ?, ?, ?, ?, 'AVAILABLE', ?)",
      )
      .run(id, floor.id, code, input.name?.trim() || `Table ${code}`, input.capacity ?? 4, outlet);
  } catch {
    const same = findTableByCode(ctx, code, outlet);
    if (same) return getTable(ctx, same.id);
    throw new AppError(`Could not create table ${code}`);
  }
  audit(ctx, "TABLE_CREATE", "dining_table", id, null, null, { code, outlet });
  return getTable(ctx, id);
}

export function getTable(ctx: AppContext, tableId: string) {
  const row = ctx.db.prepare("SELECT * FROM dining_tables WHERE id = ?").get(tableId) as
    | {
        id: string;
        code: string;
        status: TableStatus;
        current_session_id: string | null;
        outlet?: string;
      }
    | undefined;
  if (!row) throw new AppError("Table not found", 404);
  return row;
}

export function openTable(
  ctx: AppContext,
  input: { tableId: string; customerId?: string; cardId?: string; waiterId?: string; outlet?: string },
) {
  assertPermission(ctx.actor.role, "CREATE_ORDER");
  const table = getTable(ctx, input.tableId);
  if (table.status !== "AVAILABLE" && table.status !== "RESERVED") {
    throw new AppError(`Table ${table.code} is ${table.status}`);
  }
  const outlet = table.outlet || input.outlet?.trim() || "BAR";
  const sessionId = uuid();
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO table_sessions (id, table_id, customer_id, card_id, waiter_id, status, opened_at, outlet)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
    )
    .run(sessionId, table.id, input.customerId ?? null, input.cardId ?? null, input.waiterId ?? ctx.actor.staffId, now, outlet);
  ctx.db
    .prepare("UPDATE dining_tables SET status = 'OCCUPIED', current_session_id = ? WHERE id = ?")
    .run(sessionId, table.id);
  audit(ctx, "TABLE_OPEN", "dining_table", table.id, null, "AVAILABLE", "OCCUPIED");
  return { table: getTable(ctx, table.id), sessionId };
}

export function checkIn(
  ctx: AppContext,
  input: { customerId: string; cardId?: string; tableId: string; waiterId?: string },
) {
  const opened = openTable(ctx, input);
  const id = uuid();
  ctx.db
    .prepare(
      `INSERT INTO checkins (id, customer_id, card_id, table_id, session_id, waiter_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.customerId,
      input.cardId ?? null,
      input.tableId,
      opened.sessionId,
      input.waiterId ?? ctx.actor.staffId,
      nowIso(),
    );
  audit(ctx, "CHECKIN", "checkin", id, null, null, input);
  return { ...opened, checkinId: id };
}

export function requestBill(ctx: AppContext, tableId: string) {
  assertPermission(ctx.actor.role, "REQUEST_BILL");
  const table = getTable(ctx, tableId);
  if (!table.current_session_id) throw new AppError("Table has no open session");
  ctx.db.prepare("UPDATE dining_tables SET status = 'BILL_REQUESTED' WHERE id = ?").run(tableId);
  ctx.db.prepare("UPDATE orders SET status = 'BILL_REQUESTED' WHERE session_id = ? AND status = 'OPEN'").run(
    table.current_session_id,
  );
  audit(ctx, "BILL_REQUEST", "dining_table", tableId, null, table.status, "BILL_REQUESTED");
  return getTable(ctx, tableId);
}

export function setTableStatus(ctx: AppContext, tableId: string, status: TableStatus) {
  ctx.db.prepare("UPDATE dining_tables SET status = ? WHERE id = ?").run(status, tableId);
}

export function closeTable(ctx: AppContext, tableId: string) {
  const table = getTable(ctx, tableId);
  if (table.current_session_id) {
    ctx.db
      .prepare("UPDATE table_sessions SET status = 'CLOSED', closed_at = ? WHERE id = ?")
      .run(nowIso(), table.current_session_id);
  }
  ctx.db
    .prepare("UPDATE dining_tables SET status = 'AVAILABLE', current_session_id = NULL, merged_into_table_id = NULL WHERE id = ?")
    .run(tableId);
  audit(ctx, "TABLE_CLOSE", "dining_table", tableId, null, table.status, "AVAILABLE");
  return getTable(ctx, tableId);
}

export function transferTable(ctx: AppContext, fromTableId: string, toTableId: string, reason?: string) {
  if (fromTableId === toTableId) throw new AppError("Cannot transfer a table to itself");
  const from = getTable(ctx, fromTableId);
  const to = getTable(ctx, toTableId);
  if (!from.current_session_id) throw new AppError("Source table has no running order");
  if (to.status !== "AVAILABLE") throw new AppError(`Destination table ${to.code} is not available`);

  const sessionId = from.current_session_id;
  ctx.db.prepare("UPDATE table_sessions SET table_id = ? WHERE id = ?").run(to.id, sessionId);
  ctx.db.prepare("UPDATE orders SET table_id = ? WHERE session_id = ?").run(to.id, sessionId);
  ctx.db.prepare("UPDATE kots SET table_id = ? WHERE session_id = ?").run(to.id, sessionId);
  ctx.db.prepare("UPDATE invoices SET table_id = ? WHERE session_id = ?").run(to.id, sessionId);
  ctx.db
    .prepare("UPDATE dining_tables SET status = ?, current_session_id = ?, outlet = ? WHERE id = ?")
    .run(from.status === "AVAILABLE" ? "OCCUPIED" : from.status, sessionId, from.outlet || "BAR", to.id);
  ctx.db
    .prepare("UPDATE dining_tables SET status = 'AVAILABLE', current_session_id = NULL WHERE id = ?")
    .run(from.id);

  const transferId = uuid();
  ctx.db
    .prepare(
      `INSERT INTO table_transfers (id, from_table_id, to_table_id, session_id, staff_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(transferId, from.id, to.id, sessionId, ctx.actor.staffId, reason ?? null, nowIso());
  audit(ctx, "TABLE_TRANSFER", "dining_table", from.id, reason ?? null, from.code, to.code);
  return { transferId, from: getTable(ctx, from.id), to: getTable(ctx, to.id), sessionId };
}

export function listTableItems(ctx: AppContext, tableId: string) {
  getTable(ctx, tableId);
  return ctx.db
    .prepare(
      `SELECT oi.id, oi.name, oi.qty, oi.unit_price, COALESCE(p.sku, '') AS sku,
              COALESCE(k.kot_number, '') AS kot_number
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN kots k ON k.id = oi.kot_id
        WHERE o.table_id = ? AND o.status IN ('OPEN','BILL_REQUESTED','SETTLING') AND oi.voided = 0
        ORDER BY oi.rowid`,
    )
    .all(tableId) as Array<{
    id: string;
    name: string;
    qty: number;
    unit_price: number;
    sku: string;
    kot_number: string;
  }>;
}

function openOrderOnTable(ctx: AppContext, tableId: string) {
  const table = getTable(ctx, tableId);
  if (!table.current_session_id) throw new AppError("Destination table has no running order");
  const existing = ctx.db
    .prepare(
      `SELECT id FROM orders
        WHERE session_id = ? AND status IN ('OPEN','BILL_REQUESTED','SETTLING')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(table.current_session_id) as { id: string } | undefined;
  if (existing) return existing;
  const id = uuid();
  ctx.db
    .prepare(
      `INSERT INTO orders (id, order_number, session_id, table_id, waiter_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?)`,
    )
    .run(id, nextNumber(ctx.db, "order", "ORD-"), table.current_session_id, table.id, ctx.actor.staffId, nowIso());
  return { id };
}

export function transferItems(
  ctx: AppContext,
  fromTableId: string,
  toTableId: string,
  itemIds: string[],
  reason?: string,
) {
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (!ids.length) throw new AppError("Select items to transfer");
  if (fromTableId === toTableId) throw new AppError("Cannot transfer items to the same table");
  const from = getTable(ctx, fromTableId);
  if (!from.current_session_id) throw new AppError("Current table has no running order");
  let to = getTable(ctx, toTableId);
  if (to.status === "AVAILABLE") {
    openTable(ctx, { tableId: to.id, waiterId: ctx.actor.staffId });
    to = getTable(ctx, to.id);
  }
  const destOrder = openOrderOnTable(ctx, to.id);
  const movedKots = new Set<string>();
  for (const itemId of ids) {
    const row = ctx.db
      .prepare(
        `SELECT oi.id, oi.kot_id FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE oi.id = ? AND o.table_id = ? AND oi.voided = 0`,
      )
      .get(itemId, from.id) as { id: string; kot_id: string | null } | undefined;
    if (!row) throw new AppError("Item is not on the current table");
    ctx.db.prepare("UPDATE order_items SET order_id = ? WHERE id = ?").run(destOrder.id, itemId);
    if (row.kot_id) movedKots.add(row.kot_id);
  }
  const dest = getTable(ctx, to.id);
  for (const kotId of movedKots) {
    const left = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE oi.kot_id = ? AND o.table_id = ? AND oi.voided = 0`,
      )
      .get(kotId, from.id) as { n: number };
    if (left.n || !dest.current_session_id) continue;
    ctx.db
      .prepare("UPDATE kots SET table_id = ?, session_id = ?, order_id = ? WHERE id = ?")
      .run(dest.id, dest.current_session_id, destOrder.id, kotId);
  }
  const remaining = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.table_id = ? AND o.status IN ('OPEN','BILL_REQUESTED','SETTLING') AND oi.voided = 0`,
    )
    .get(from.id) as { n: number };
  if (!remaining.n) closeTable(ctx, from.id);
  audit(ctx, "ITEM_TRANSFER", "dining_table", from.id, reason ?? null, from.code, { to: to.code, itemIds: ids });
  return {
    from: getTable(ctx, from.id),
    to: getTable(ctx, to.id),
    moved: ids.length,
    sourceClosed: !remaining.n,
  };
}

export function mergeTables(ctx: AppContext, sourceTableId: string, targetTableId: string) {
  const source = getTable(ctx, sourceTableId);
  const target = getTable(ctx, targetTableId);
  if (!source.current_session_id || !target.current_session_id) {
    throw new AppError("Both tables must have running orders to merge");
  }
  const sourceSession = source.current_session_id;
  const targetSession = target.current_session_id;

  const sourceOrder = ctx.db
    .prepare("SELECT id FROM orders WHERE session_id = ? ORDER BY created_at LIMIT 1")
    .get(sourceSession) as { id: string } | undefined;
  const targetOrder = ctx.db
    .prepare("SELECT id FROM orders WHERE session_id = ? ORDER BY created_at LIMIT 1")
    .get(targetSession) as { id: string } | undefined;
  if (!sourceOrder || !targetOrder) throw new AppError("Both tables must have orders to merge");

  ctx.db.prepare("UPDATE order_items SET order_id = ? WHERE order_id = ?").run(targetOrder.id, sourceOrder.id);
  ctx.db
    .prepare("UPDATE kots SET session_id = ?, table_id = ?, order_id = ? WHERE session_id = ?")
    .run(targetSession, target.id, targetOrder.id, sourceSession);
  ctx.db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE id = ?").run(sourceOrder.id);
  ctx.db
    .prepare("UPDATE table_sessions SET status = 'MERGED', closed_at = ? WHERE id = ?")
    .run(nowIso(), sourceSession);
  ctx.db
    .prepare("UPDATE dining_tables SET status = 'AVAILABLE', current_session_id = NULL, merged_into_table_id = ? WHERE id = ?")
    .run(target.id, source.id);

  const mergeId = uuid();
  ctx.db
    .prepare(
      `INSERT INTO table_merges
        (id, source_table_id, target_table_id, source_session_id, target_session_id, staff_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(mergeId, source.id, target.id, sourceSession, targetSession, ctx.actor.staffId, nowIso());
  audit(ctx, "TABLE_MERGE", "dining_table", source.id, null, source.code, target.code);
  return { mergeId, source: getTable(ctx, source.id), target: getTable(ctx, target.id) };
}

export function splitTable(
  ctx: AppContext,
  input: {
    tableId: string;
    type: SplitType;
    destinationTableId?: string;
    itemIds?: string[];
    quantitySplits?: Array<{ itemId: string; qty: number }>;
    amounts?: number[];
    parts?: number;
  },
) {
  const table = getTable(ctx, input.tableId);
  if (!table.current_session_id) throw new AppError("Table has no running order");
  const payload = JSON.stringify(input);
  const splitId = uuid();
  ctx.db
    .prepare(
      "INSERT INTO table_splits (id, session_id, type, staff_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(splitId, table.current_session_id, input.type, ctx.actor.staffId, payload, nowIso());

  if (input.type === "ITEM" || input.type === "QUANTITY") {
    if (!input.destinationTableId) throw new AppError("Destination table is required");
    const dest = getTable(ctx, input.destinationTableId);
    if (dest.status !== "AVAILABLE") throw new AppError("Destination table must be available");
    const opened = openTable(ctx, { tableId: dest.id, waiterId: ctx.actor.staffId });
    const destOrderId = uuid();
    const destOrderNumber = `ORD-SPLIT-${splitId.slice(0, 6)}`;
    ctx.db
      .prepare(
        `INSERT INTO orders (id, order_number, session_id, table_id, waiter_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'OPEN', ?)`,
      )
      .run(destOrderId, destOrderNumber, opened.sessionId, dest.id, ctx.actor.staffId, nowIso());

    if (input.type === "ITEM") {
      for (const itemId of input.itemIds ?? []) {
        ctx.db.prepare("UPDATE order_items SET order_id = ?, split_group = ? WHERE id = ?").run(
          destOrderId,
          splitId,
          itemId,
        );
      }
    } else {
      for (const split of input.quantitySplits ?? []) {
        const item = ctx.db.prepare("SELECT * FROM order_items WHERE id = ?").get(split.itemId) as
          | {
              id: string;
              order_id: string;
              product_id: string;
              name: string;
              station: string;
              qty: number;
              unit_price: number;
              tax_rate: number;
              notes: string | null;
            }
          | undefined;
        if (!item) continue;
        if (split.qty >= item.qty) throw new AppError("Split quantity must be less than item quantity");
        ctx.db.prepare("UPDATE order_items SET qty = qty - ? WHERE id = ?").run(split.qty, item.id);
        ctx.db
          .prepare(
            `INSERT INTO order_items
              (id, order_id, product_id, name, station, qty, unit_price, tax_rate, notes, status, split_group)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
          )
          .run(
            uuid(),
            destOrderId,
            item.product_id,
            item.name,
            item.station,
            split.qty,
            item.unit_price,
            item.tax_rate,
            item.notes,
            splitId,
          );
      }
    }
  }

  audit(ctx, "TABLE_SPLIT", "dining_table", table.id, input.type, null, input);
  return { splitId, type: input.type };
}

export function waiterTables(ctx: AppContext, waiterId: string) {
  return ctx.db
    .prepare(
      `SELECT t.*, f.name AS floor_name
       FROM dining_tables t
       JOIN floors f ON f.id = t.floor_id
       JOIN table_sessions s ON s.id = t.current_session_id
       WHERE s.waiter_id = ?`,
    )
    .all(waiterId);
}
