import { describe, expect, it } from "vitest";
import { audit } from "../src/server/lib/audit.js";
import { addItem, cancelItem, createOrder, sendKot, voidKot } from "../src/server/services/orderService.js";
import { kotCancellationReport } from "../src/server/services/reportService.js";
import { getTableByCode, openTable } from "../src/server/services/tableService.js";
import { createTestApp } from "./helpers.js";

const filters = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", username: "", tableNo: "", page: 1 };

describe("KOT cancellation report", () => {
  it("reports reduction slips and full voids with their original table and operator", async () => {
    const { db, seeded, ctx } = createTestApp();
    const cashier = ctx("cashier");
    const owner = ctx("owner");
    const table = getTableByCode(cashier, "01");
    db.prepare("UPDATE dining_tables SET name = 'Original table' WHERE id = ?").run(table.id);
    openTable(cashier, { tableId: table.id });
    const order = createOrder(cashier, table.id) as { id: string };
    const productId = seeded.products["FOOD-PZ"];
    addItem(cashier, { orderId: order.id, productId, qty: 2 });
    const [original] = await sendKot(cashier, order.id);
    addItem(cashier, { orderId: order.id, productId, qty: -1 });
    const [slip] = await sendKot(cashier, order.id, { remark: "Guest changed order" });
    const { id } = db.prepare("SELECT id FROM kots WHERE kot_number = ?").get(original.kot_number) as { id: string };
    voidKot(owner, id, "Kitchen confirmed");
    voidKot(owner, id, "Duplicate request");
    db.prepare("UPDATE dining_tables SET name = 'Renamed' WHERE id = ?").run(table.id);

    const report = kotCancellationReport(cashier, filters);
    expect(report.rows).toHaveLength(2);
    expect(report.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kot_number: slip.kot_number, username: "cashier", table_no: "01", table_name: "Original table", remark: "Guest changed order" }),
      expect.objectContaining({ kot_number: original.kot_number, username: "owner", remark: "Kitchen confirmed" }),
    ]));
    expect(kotCancellationReport(cashier, { ...filters, username: "CASHIER", tableNo: "01" }).rows).toHaveLength(1);
    expect(kotCancellationReport(cashier, { ...filters, tableNo: "02" }).rows).toHaveLength(0);
    expect(kotCancellationReport(cashier, { ...filters, to: "2001-01-01T00:00:00Z" }).rows).toHaveLength(0);

    db.prepare("DELETE FROM audit_log WHERE action = 'KOT_CANCEL_SLIP'").run();
    expect(kotCancellationReport(cashier, { ...filters, username: "cashier" }).rows).toEqual([
      expect.objectContaining({ kot_number: slip.kot_number, remark: "Guest changed order" }),
    ]);
  });

  it("uses legacy item cancellation remarks and collapses duplicate legacy void audit entries", async () => {
    const { db, seeded, ctx } = createTestApp();
    const cashier = ctx("cashier");
    const owner = ctx("owner");
    const table = getTableByCode(cashier, "01");
    openTable(cashier, { tableId: table.id });
    const order = createOrder(cashier, table.id) as { id: string };
    addItem(cashier, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const [original] = await sendKot(cashier, order.id);
    const item = db.prepare("SELECT id, kot_id FROM order_items WHERE order_id = ?").get(order.id) as { id: string; kot_id: string };
    cancelItem(cashier, item.id, "Wrong item");
    db.prepare("DELETE FROM audit_log WHERE action = 'KOT_CANCEL_SLIP'").run();
    db.prepare("UPDATE kots SET notes = NULL WHERE type = 'CANCEL'").run();
    audit(owner, "KOT_CANCEL", "kot", item.kot_id, "void", "SENT", "VOID");
    audit(owner, "KOT_CANCEL", "kot", item.kot_id, "Test legacy reason", null, "VOID");

    const report = kotCancellationReport(cashier, filters);
    expect(report.rows).toHaveLength(2);
    expect(report.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: "cashier", remark: "Wrong item" }),
      expect.objectContaining({ kot_number: original.kot_number, username: "owner", remark: "Test legacy reason" }),
    ]));
  });

  it("returns bounded pages with stable ordering when cancellation times match", async () => {
    const { db, seeded, ctx } = createTestApp();
    const cashier = ctx("cashier");
    const table = getTableByCode(cashier, "01");
    openTable(cashier, { tableId: table.id });
    const order = createOrder(cashier, table.id) as { id: string };
    addItem(cashier, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    await sendKot(cashier, order.id);
    db.prepare(`
      WITH RECURSIVE seq(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM seq WHERE n < 101)
      INSERT INTO kots (id, kot_number, order_id, session_id, table_id, station, type, created_at)
      SELECT printf('slip-%03d', n), printf('TEST-%03d', n),
             k.order_id, k.session_id, k.table_id, k.station, 'CANCEL', k.created_at
        FROM seq CROSS JOIN kots k
       WHERE k.order_id = ? AND k.type = 'NEW'
    `).run(order.id);

    const first = kotCancellationReport(cashier, filters);
    const second = kotCancellationReport(cashier, { ...filters, page: 2 });
    expect(first.rows).toHaveLength(100);
    expect(first.hasNext).toBe(true);
    expect(second.rows).toEqual([expect.objectContaining({ kot_number: "TEST-001" })]);
    expect(second.hasNext).toBe(false);
  });
});
