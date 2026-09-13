import { uuid, nowIso } from "../lib/ids.js";
import { audit } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import type { AppContext } from "../lib/context.js";
import { assertPermission } from "../../shared/permissions.js";

export function deductStock(ctx: AppContext, productId: string, qty: number, reference: string): void {
  const product = ctx.db
    .prepare("SELECT track_inventory FROM products WHERE id = ?")
    .get(productId) as { track_inventory: number } | undefined;
  if (!product || !product.track_inventory) return;

  const inv = ctx.db
    .prepare("SELECT quantity FROM inventory WHERE product_id = ?")
    .get(productId) as { quantity: number } | undefined;
  if (!inv) {
    ctx.db.prepare("INSERT INTO inventory (product_id, quantity, reserved) VALUES (?, 0, 0)").run(productId);
  }
  const current = inv?.quantity ?? 0;
  ctx.db.prepare("UPDATE inventory SET quantity = quantity - ? WHERE product_id = ?").run(qty, productId);
  ctx.db
    .prepare(
      "INSERT INTO inventory_movements (id, product_id, type, quantity, reference, created_at) VALUES (?, ?, 'SALE', ?, ?, ?)",
    )
    .run(uuid(), productId, -qty, reference, nowIso());
  if (current - qty < 0) {
    audit(ctx, "INVENTORY_NEGATIVE", "inventory", productId, reference, current, current - qty);
  }
}

export function restoreStock(ctx: AppContext, productId: string, qty: number, reference: string): void {
  const product = ctx.db
    .prepare("SELECT track_inventory FROM products WHERE id = ?")
    .get(productId) as { track_inventory: number } | undefined;
  if (!product || !product.track_inventory) return;
  ctx.db.prepare("UPDATE inventory SET quantity = quantity + ? WHERE product_id = ?").run(qty, productId);
  ctx.db
    .prepare(
      "INSERT INTO inventory_movements (id, product_id, type, quantity, reference, created_at) VALUES (?, ?, 'REVERSAL', ?, ?, ?)",
    )
    .run(uuid(), productId, qty, reference, nowIso());
}

export function receivePurchase(
  ctx: AppContext,
  supplier: string,
  items: Array<{ productId: string; qty: number; cost: number }>,
): { id: string } {
  assertPermission(ctx.actor.role, "MODIFY_STOCK");
  if (!items.length) throw new AppError("Purchase must include items");
  const id = uuid();
  const total = items.reduce((s, i) => s + i.qty * i.cost, 0);
  const now = nowIso();
  ctx.db
    .prepare("INSERT INTO purchases (id, supplier, total, staff_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, supplier, total, ctx.actor.staffId, now);
  for (const item of items) {
    ctx.db
      .prepare("INSERT INTO purchase_items (id, purchase_id, product_id, qty, cost) VALUES (?, ?, ?, ?, ?)")
      .run(uuid(), id, item.productId, item.qty, item.cost);
    ctx.db.prepare("UPDATE inventory SET quantity = quantity + ? WHERE product_id = ?").run(item.qty, item.productId);
    ctx.db
      .prepare(
        "INSERT INTO inventory_movements (id, product_id, type, quantity, reference, created_at) VALUES (?, ?, 'PURCHASE', ?, ?, ?)",
      )
      .run(uuid(), item.productId, item.qty, id, now);
  }
  audit(ctx, "PURCHASE", "purchase", id, supplier, null, { supplier, total, items });
  return { id };
}

export function addExpense(ctx: AppContext, category: string, amount: number, note?: string): { id: string } {
  const id = uuid();
  ctx.db
    .prepare("INSERT INTO expenses (id, category, amount, note, staff_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, category, amount, note ?? null, ctx.actor.staffId, nowIso());
  audit(ctx, "EXPENSE", "expense", id, note ?? null, null, { category, amount });
  return { id };
}

export function listInventory(ctx: AppContext) {
  return ctx.db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.station, i.quantity, i.reserved
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE p.active = 1
       ORDER BY p.station, p.name`,
    )
    .all();
}
