import { assertPermission } from "../../shared/permissions.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { nowIso, uuid } from "../lib/ids.js";
import type { SplitType, TableStatus } from "../../shared/types.js";

export function listFloors(ctx: AppContext) {
  return ctx.db.prepare("SELECT * FROM floors ORDER BY sort_order, name").all();
}

export function listTables(ctx: AppContext) {
  return ctx.db
    .prepare(
      `SELECT t.*, f.name AS floor_name, s.customer_id, s.card_id, s.waiter_id, s.id AS session_id,
              cu.name AS customer_name, c.card_number, st.name AS waiter_name,
              (SELECT COALESCE(SUM(oi.qty * oi.unit_price), 0)
                 FROM orders o JOIN order_items oi ON oi.order_id = o.id
                WHERE o.session_id = t.current_session_id AND oi.voided = 0) AS running_total
       FROM dining_tables t
       JOIN floors f ON f.id = t.floor_id
       LEFT JOIN table_sessions s ON s.id = t.current_session_id
       LEFT JOIN customers cu ON cu.id = s.customer_id
       LEFT JOIN member_cards c ON c.id = s.card_id
       LEFT JOIN staff st ON st.id = s.waiter_id
       ORDER BY f.sort_order, t.code`,
    )
    .all();
}

export function getTableByCode(ctx: AppContext, code: string) {
  const row = ctx.db.prepare("SELECT * FROM dining_tables WHERE code = ?").get(code) as
    | {
        id: string;
        code: string;
        status: TableStatus;
        current_session_id: string | null;
      }
    | undefined;
  if (!row) throw new AppError(`Table ${code} not found`, 404);
  return row;
}

export function getTable(ctx: AppContext, tableId: string) {
  const row = ctx.db.prepare("SELECT * FROM dining_tables WHERE id = ?").get(tableId) as
    | {
        id: string;
        code: string;
        status: TableStatus;
        current_session_id: string | null;
      }
    | undefined;
  if (!row) throw new AppError("Table not found", 404);
  return row;
}

export function openTable(
  ctx: AppContext,
  input: { tableId: string; customerId?: string; cardId?: string; waiterId?: string },
) {
  assertPermission(ctx.actor.role, "CREATE_ORDER");
  const table = getTable(ctx, input.tableId);
  if (table.status !== "AVAILABLE" && table.status !== "RESERVED") {
    throw new AppError(`Table ${table.code} is ${table.status}`);
  }
  const sessionId = uuid();
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO table_sessions (id, table_id, customer_id, card_id, waiter_id, status, opened_at)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?)`,
    )
    .run(sessionId, table.id, input.customerId ?? null, input.cardId ?? null, input.waiterId ?? ctx.actor.staffId, now);
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
    .prepare("UPDATE dining_tables SET status = ?, current_session_id = ? WHERE id = ?")
    .run(from.status === "AVAILABLE" ? "OCCUPIED" : from.status, sessionId, to.id);
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
