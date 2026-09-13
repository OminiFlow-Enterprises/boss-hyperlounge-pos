import { describe, expect, it } from "vitest";
import { rupeesToPaise } from "../src/shared/money.js";
import { openTable, transferTable, mergeTables, getTableByCode, splitTable } from "../src/server/services/tableService.js";
import { addItem, createOrder, sendKot, getOrderDetail, reprintKot } from "../src/server/services/orderService.js";
import { generateInvoice, settleInvoice, previewBill } from "../src/server/services/billingService.js";
import { setSetting } from "../src/server/services/settingsService.js";
import { resolvePrice } from "../src/server/services/pricingService.js";
import { createTestApp } from "./helpers.js";

describe("tables, KOT and billing", () => {
  it("transfers a running order and its KOTs", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const from = getTableByCode(waiter, "01");
    const to = getTableByCode(waiter, "08");
    openTable(waiter, { tableId: from.id });
    const order = createOrder(waiter, from.id) as { id: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    await sendKot(waiter, order.id);
    transferTable(waiter, from.id, to.id, "Guest moved");
    expect(getTableByCode(waiter, "01").status).toBe("AVAILABLE");
    expect(getTableByCode(waiter, "08").status).toBe("OCCUPIED");
    const moved = getOrderDetail(waiter, order.id);
    expect((moved.order as { table_id: string }).table_id).toBe(to.id);
    expect(moved.kots).toHaveLength(1);
  });

  it("merges two occupied tables into one bill", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const a = getTableByCode(waiter, "01");
    const b = getTableByCode(waiter, "02");
    openTable(waiter, { tableId: a.id });
    openTable(waiter, { tableId: b.id });
    const orderA = createOrder(waiter, a.id) as { id: string };
    const orderB = createOrder(waiter, b.id) as { id: string };
    addItem(waiter, { orderId: orderA.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    addItem(waiter, { orderId: orderB.id, productId: seeded.products["BAR-WH"], qty: 1 });
    mergeTables(waiter, a.id, b.id);
    expect(getTableByCode(waiter, "01").status).toBe("AVAILABLE");
    const bill = previewBill(cashier, orderB.id);
    expect(bill.grandTotal).toBe(rupeesToPaise(900));
  });

  it("splits selected items onto another table", () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const a = getTableByCode(waiter, "01");
    const dest = getTableByCode(waiter, "03");
    openTable(waiter, { tableId: a.id });
    const order = createOrder(waiter, a.id) as { id: string };
    const pizza = addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 }) as { id: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["BAR-WH"], qty: 1 });
    splitTable(waiter, { tableId: a.id, type: "ITEM", destinationTableId: dest.id, itemIds: [pizza.id] });
    expect(getTableByCode(waiter, "03").status).toBe("OCCUPIED");
  });

  it("supports split cash + card settlement", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const table = getTableByCode(waiter, "04");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const invoice = generateInvoice(cashier, order.id) as { id: string; grand_total: number };
    const first = settleInvoice(cashier, invoice.id, [{ method: "CASH", amount: rupeesToPaise(200) }]);
    expect(first.complete).toBe(false);
    const done = settleInvoice(cashier, invoice.id, [{ method: "UPI", amount: rupeesToPaise(400) }]);
    expect(done.complete).toBe(true);
    expect(getTableByCode(cashier, "04").status).toBe("AVAILABLE");
  });

  it("marks KOT reprints and uses happy-hour whisky price", async () => {
    const { seeded, hardware, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    const table = getTableByCode(waiter, "05");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    const fridayHappy = new Date(2026, 8, 11, 17, 30, 0);
    const price = resolvePrice(cashier, seeded.products["BAR-WH"], seeded.cardTypes.REGULAR, fridayHappy);
    expect(price.unitPrice).toBe(rupeesToPaise(200));
    expect(price.source).toBe("HAPPY_HOUR");
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-FF"], qty: 1 });
    const [kot] = await sendKot(waiter, order.id);
    await reprintKot(cashier, kot.id);
    const reprint = hardware.kitchen.logs.find((l) => l.reprint);
    expect(reprint).toBeTruthy();
    expect((reprint?.payload as { reprint: boolean }).reprint).toBe(true);
  });
});
