import { describe, expect, it } from "vitest";
import { rupeesToPaise } from "../src/shared/money.js";
import { MemoryCloudSink, flushSync } from "../src/server/services/syncService.js";
import { issueCard, rechargeCard, cardLedger, balancesFromLedger } from "../src/server/services/cardService.js";
import { checkIn, requestBill, getTableByCode } from "../src/server/services/tableService.js";
import { addItem, createOrder, sendKot, advanceKot, listKots } from "../src/server/services/orderService.js";
import { generateInvoice, previewBill, settleInvoice } from "../src/server/services/billingService.js";
import { setSetting } from "../src/server/services/settingsService.js";
import { salesReport } from "../src/server/services/reportService.js";
import { createTestApp } from "./helpers.js";

describe("BOSS Hyperlounge acceptance workflow", () => {
  it("runs customer → card → recharge → table 12 → KOT → settlement → ledger → sync", async () => {
    const { db, seeded, hardware, ctx } = createTestApp();
    const cashier = ctx("cashier");
    const waiter = ctx("waiter");
    const kitchen = ctx("kitchen");
    const bar = ctx("bar");
    const owner = ctx("owner");
    setSetting(cashier, "service_charge_pct", "0");

    const card = issueCard(cashier, {
      customer: { name: "Ishaan Rao", mobile: "9898989800" },
      cardNumber: "HL-12001",
      cardUid: "RFID-AA-12001",
      cardTypeCode: "REGULAR",
    });
    expect(card.status).toBe("ACTIVE");
    expect(card.card_uid).toBe("RFID-AA-12001");

    const recharge = rechargeCard(cashier, {
      cardId: card.id,
      amount: rupeesToPaise(5000),
      paymentMode: "CASH",
      printReceipt: true,
      applyBonus: false,
    });
    expect(recharge.card.paid_balance).toBe(rupeesToPaise(5000));
    expect(hardware.receipt.logs.some((l) => l.kind === "receipt")).toBe(true);

    const table = getTableByCode(waiter, "12");
    const opened = checkIn(waiter, {
      customerId: card.customer_id,
      cardId: card.id,
      tableId: table.id,
    });
    expect(opened.table.status).toBe("OCCUPIED");

    const order = createOrder(waiter, table.id) as { id: string; order_number: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1, notes: "No onion" });
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PT"], qty: 2, notes: "Less spicy" });
    addItem(waiter, { orderId: order.id, productId: seeded.products["BAR-WH"], qty: 2 });

    const firstKots = await sendKot(waiter, order.id);
    expect(firstKots).toHaveLength(2);
    expect(firstKots.map((k) => k.station).sort()).toEqual(["BAR", "KITCHEN"]);
    expect(hardware.kitchen.logs.some((l) => l.kind === "kot" && !l.reprint)).toBe(true);
    expect(hardware.bar.logs.some((l) => l.kind === "kot")).toBe(true);

    const kitchenKot = firstKots.find((k) => k.station === "KITCHEN")!;
    const barKot = firstKots.find((k) => k.station === "BAR")!;
    advanceKot(kitchen, kitchenKot.id, "ACCEPTED");
    advanceKot(kitchen, kitchenKot.id, "PREPARING");
    advanceKot(kitchen, kitchenKot.id, "READY");
    advanceKot(bar, barKot.id, "ACCEPTED");
    advanceKot(bar, barKot.id, "PREPARING");
    advanceKot(bar, barKot.id, "READY");

    addItem(waiter, { orderId: order.id, productId: seeded.products["BAR-CK"], qty: 2 });
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-FF"], qty: 4 });
    const extra = await sendKot(waiter, order.id);
    expect(extra.every((k) => k.type === "ADDITION")).toBe(true);

    requestBill(waiter, table.id);
    expect(getTableByCode(cashier, "12").status).toBe("BILL_REQUESTED");

    const bill = previewBill(cashier, order.id);
    expect(bill.grandTotal).toBe(rupeesToPaise(4200));
    expect(bill.foodTotal).toBe(rupeesToPaise(2200));
    expect(bill.drinksTotal).toBe(rupeesToPaise(2000));

    const invoice = generateInvoice(cashier, order.id) as { id: string; grand_total: number };
    const paid = settleInvoice(cashier, invoice.id, [
      { method: "MEMBER_CARD", amount: rupeesToPaise(4200), memberCardId: card.id },
    ]);
    expect(paid.complete).toBe(true);
    expect((paid.invoice as { status: string }).status).toBe("PAID");

    const remaining = balancesFromLedger(cashier, card.id);
    expect(remaining.usable).toBe(rupeesToPaise(800));
    expect(getTableByCode(cashier, "12").status).toBe("AVAILABLE");
    expect(hardware.receipt.logs.filter((l) => l.kind === "receipt").length).toBeGreaterThanOrEqual(2);

    const ledger = cardLedger(cashier, { cardId: card.id });
    expect(ledger.some((r: { type: string }) => r.type === "RECHARGE")).toBe(true);
    expect(ledger.some((r: { type: string }) => r.type === "PURCHASE")).toBe(true);

    const pizzaStock = db.prepare("SELECT quantity FROM inventory WHERE product_id = ?").get(seeded.products["FOOD-PZ"]) as {
      quantity: number;
    };
    expect(pizzaStock.quantity).toBe(39);

    const kots = listKots(cashier);
    expect(kots.length).toBeGreaterThanOrEqual(4);
    expect(kots.every((k) => k.items.length >= 1)).toBe(true);

    const sales = salesReport(owner);
    expect(sales.invoices).toHaveLength(1);
    expect((sales.invoices[0] as { grand_total: number }).grand_total).toBe(rupeesToPaise(4200));

    const pending = db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE status='PENDING'").get() as { n: number };
    expect(pending.n).toBeGreaterThan(0);
    const sink = new MemoryCloudSink();
    const first = await flushSync(cashier, sink);
    expect(first.synced).toBeGreaterThan(0);
    const second = await flushSync(cashier, sink);
    expect(second.synced).toBe(0);
    expect(sink.items.length).toBe(sink.seen.size);
  });
});
