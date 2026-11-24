import { describe, expect, it } from "vitest";
import { rupeesToPaise } from "../src/shared/money.js";
import { openTable, getTableByCode } from "../src/server/services/tableService.js";
import { addItem, createOrder } from "../src/server/services/orderService.js";
import { generateInvoice, settleInvoice } from "../src/server/services/billingService.js";
import { setSetting } from "../src/server/services/settingsService.js";
import { cardSettlementBills, cardSettlementReport, saveBooking } from "../src/server/services/reportService.js";
import { createTestApp } from "./helpers.js";

describe("card settlement report", () => {
  it("lists the card recharge and only the bills that used that recharge", () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");

    const first = saveBooking(cashier, {
      guestName: "Jai",
      cardNo: "1001",
      advance: rupeesToPaise(2000),
      mop: "CASH",
    }) as { id: string; card: { id: string } };
    const table = getTableByCode(waiter, "01");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const invoice = generateInvoice(cashier, order.id) as { id: string; invoice_number: string; grand_total: number };
    expect(invoice.grand_total).toBeLessThan(rupeesToPaise(2000));
    settleInvoice(cashier, invoice.id, [{ method: "MEMBER_CARD", amount: invoice.grand_total, memberCardId: first.card.id }]);

    const second = saveBooking(cashier, {
      guestName: "Jai",
      cardNo: "1001",
      advance: rupeesToPaise(1500),
      mop: "BANK TRANSFER / HDFC",
    }) as { id: string; card: { id: string } };
    const table2 = getTableByCode(waiter, "02");
    openTable(waiter, { tableId: table2.id });
    const order2 = createOrder(waiter, table2.id) as { id: string };
    addItem(waiter, { orderId: order2.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const invoice2 = generateInvoice(cashier, order2.id) as { id: string; invoice_number: string; grand_total: number };
    settleInvoice(cashier, invoice2.id, [{ method: "MEMBER_CARD", amount: invoice2.grand_total, memberCardId: second.card.id }]);

    saveBooking(cashier, { guestName: "Other", cardNo: "1002", advance: rupeesToPaise(500), mop: "CASH" });

    const day = new Date().toISOString().slice(0, 10);
    const report = cardSettlementReport(cashier, day, day);
    const cards = report.rows.map((r) => r.card_no);
    expect(cards.filter((n) => n === "1001")).toHaveLength(2);
    expect(cards).toContain("1002");

    const filtered = cardSettlementReport(cashier, day, day, "1001");
    expect(filtered.rows.every((r) => r.card_no === "1001")).toBe(true);
    expect(filtered.rows).toHaveLength(2);

    const older = filtered.rows[0];
    const newer = filtered.rows[1];
    expect(older.guest_name).toBe("Jai");
    expect(older.payment_mode).toBe("CASH");
    expect(older.amount_paid).toBe(rupeesToPaise(2000));
    expect(older.card_balance).toBe(rupeesToPaise(1900));
    expect(older.remaining_balance).toBe(rupeesToPaise(1900) - invoice.grand_total);
    expect(newer.payment_mode).toBe("BANK TRANSFER / HDFC");
    expect(newer.amount_paid).toBe(rupeesToPaise(1500));
    expect(newer.card_balance).toBe(rupeesToPaise(1500));
    expect(newer.remaining_balance).toBe(rupeesToPaise(1900) - invoice.grand_total + rupeesToPaise(1500) - invoice2.grand_total);

    const firstBills = cardSettlementBills(cashier, String(older.booking_id));
    expect(firstBills.rows).toEqual([
      expect.objectContaining({
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        table_no: "Table 01",
        outlet: "BAR",
        amount: invoice.grand_total,
      }),
    ]);
    const secondBills = cardSettlementBills(cashier, String(newer.booking_id));
    expect(secondBills.rows.map((r) => r.invoice_id)).toEqual([invoice2.id]);
    expect(secondBills.rows[0].amount).toBe(invoice2.grand_total);

    const missed = cardSettlementReport(cashier, "2020-01-01", "2020-01-01", "1001");
    expect(missed.rows).toHaveLength(0);
  });

  it("keeps a back-dated recharge on that date only", () => {
    const { ctx } = createTestApp();
    const cashier = ctx("cashier");
    const saved = saveBooking(cashier, {
      guestName: "Old Guest",
      cardNo: "2214",
      advance: rupeesToPaise(300),
      mop: "CASH",
    }) as { id: string };
    ctx().db.prepare("UPDATE bookings SET created_at = ? WHERE id = ?").run("2024-05-02T12:00:00.000Z", saved.id);
    ctx().db.prepare("UPDATE card_ledger SET created_at = ? WHERE idempotency_key = ?").run("2024-05-02T12:00:00.000Z", `adv:${saved.id}`);

    const old = cardSettlementReport(cashier, "2024-05-02", "2024-05-02", "2214");
    expect(old.rows).toHaveLength(1);
    expect(old.rows[0].guest_name).toBe("Old Guest");
    expect(old.rows[0].card_balance).toBe(rupeesToPaise(200));
    expect(cardSettlementBills(cashier, saved.id).rows).toEqual([]);

    const today = new Date().toISOString().slice(0, 10);
    expect(cardSettlementReport(cashier, today, today, "2214").rows).toHaveLength(0);
  });
});
