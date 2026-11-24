import { expect, it } from "vitest";
import { generateInvoice, getInvoice, getOpenInvoiceByTable, settleInvoice } from "../src/server/services/billingService.js";
import { balancesFromLedger } from "../src/server/services/cardService.js";
import { addItem, createOrder, setBillLineQty } from "../src/server/services/orderService.js";
import { saveBooking, settlementDetail, settlementReport, updateSettlement } from "../src/server/services/reportService.js";
import { getTableByCode, openTable } from "../src/server/services/tableService.js";
import { createTestApp } from "./helpers.js";
import { businessDate, businessDateRange } from "../src/shared/businessDate.js";

it("rolls the settlement report date over at 6 a.m. IST", () => {
  expect(businessDate(new Date("2026-11-23T00:29:59.999Z"))).toBe("2026-11-22");
  expect(businessDate(new Date("2026-11-23T00:30:00.000Z"))).toBe("2026-11-23");
  expect(businessDateRange("2026-11-22")).toMatchObject({
    from: "2026-11-22T00:30:00.000Z",
    to: "2026-11-23T00:29:59.999Z",
  });
});

it("reports and filters by the cashier who took the payment", () => {
  const { ctx, seeded } = createTestApp();
  const billCreator = ctx("manager");
  const cashier = ctx("cashier");
  const table = getTableByCode(billCreator, "01");
  openTable(billCreator, { tableId: table.id });
  const order = createOrder(billCreator, table.id) as { id: string };
  addItem(billCreator, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
  const invoice = generateInvoice(billCreator, order.id, {}) as { id: string; grand_total: number };
  settleInvoice(cashier, invoice.id, [{ method: "CASH", amount: invoice.grand_total }], { printReceipt: false });

  const reportFor = (user: string) => settlementReport(billCreator, undefined, undefined, "BAR", { user }).rows;
  expect(reportFor(cashier.actor.staffName)).toEqual([
    expect.objectContaining({ invoice_id: invoice.id, username: cashier.actor.staffName }),
  ]);
  expect(reportFor(billCreator.actor.staffName)).toEqual([]);
});

it.each(["CASH", "CARD", "MEMBER_CARD"] as const)(
  "reduces a %s settlement in place and reopens the table if the bill increases",
  (method) => {
    const { ctx, seeded } = createTestApp();
    const cashier = ctx("cashier");
    const table = getTableByCode(cashier, "01");
    openTable(cashier, { tableId: table.id });
    const order = createOrder(cashier, table.id) as { id: string };
    addItem(cashier, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const booking = saveBooking(cashier, { cardNo: "1234", advance: 200_000, mop: "CASH" }) as { card: { id: string } };
    const cardId = booking.card.id;
    const invoice = generateInvoice(cashier, order.id, { serviceChargePct: 10 }) as { id: string; grand_total: number };
    settleInvoice(cashier, invoice.id, [{
      method,
      amount: invoice.grand_total,
      ...(method === "MEMBER_CARD" ? { memberCardId: cardId } : {}),
      ...(method === "CARD" ? { reference: "HDFC" } : {}),
    }], { printReceipt: false });
    const original = getInvoice(cashier, invoice.id);
    const afterPayment = balancesFromLedger(cashier, cardId);

    const reduced = generateInvoice(cashier, order.id, { invoiceId: invoice.id, serviceChargePct: 0 }) as {
      grand_total: number; status: string;
    };
    expect(reduced.status).toBe("PAID");
    expect(reduced.grand_total).toBeLessThan(invoice.grand_total);
    expect(getInvoice(cashier, invoice.id).payments).toEqual([
      { ...original.payments[0], amount: reduced.grand_total },
      expect.objectContaining({ method: "CASH", amount: 0 }),
    ]);
    const expectedCredit = method === "MEMBER_CARD" ? invoice.grand_total - reduced.grand_total : 0;
    expect(balancesFromLedger(cashier, cardId).usable).toBe(afterPayment.usable + expectedCredit);
    generateInvoice(cashier, order.id, { invoiceId: invoice.id, serviceChargePct: 0 });
    expect(balancesFromLedger(cashier, cardId).usable).toBe(afterPayment.usable + expectedCredit);

    expect(generateInvoice(cashier, order.id, { invoiceId: invoice.id, serviceChargePct: 10 }))
      .toMatchObject({ status: "PARTIAL", reopenSettlement: true });
    expect(getTableByCode(cashier, "01").status).toBe("PAYMENT_PENDING");
    const reopened = getOpenInvoiceByTable(cashier, table.id);
    expect(reopened.due).toBe(invoice.grand_total - reduced.grand_total);
    expect(settleInvoice(cashier, invoice.id, [{ method: "CASH", amount: reopened.due }], { printReceipt: false }))
      .toMatchObject({ complete: true, due: 0 });
    expect(getTableByCode(cashier, "01").status).toBe("AVAILABLE");
  },
);

it("carries partial payments forward when reopening a revised table bill", () => {
  const { ctx, seeded } = createTestApp();
  const cashier = ctx("cashier");
  const table = getTableByCode(cashier, "01");
  openTable(cashier, { tableId: table.id });
  const order = createOrder(cashier, table.id) as { id: string };
  const item = addItem(cashier, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 2 }) as { id: string };
  const invoice = generateInvoice(cashier, order.id, { serviceChargePct: 10 }) as { id: string; grand_total: number };
  const payment = 10_000;
  settleInvoice(cashier, invoice.id, [{ method: "CASH", amount: payment }], { printReceipt: false });

  function revise(qty: number, serviceChargePct: number) {
    setBillLineQty(cashier, order.id, [item.id], qty, { allowPaid: false });
    const revised = generateInvoice(cashier, order.id, { invoiceId: invoice.id, serviceChargePct }) as {
      id: string; grand_total: number;
    };
    const reopened = getOpenInvoiceByTable(cashier, table.id);
    expect(reopened).toMatchObject({
      invoice: { id: invoice.id, status: "PARTIAL" },
      paid: payment,
      due: revised.grand_total - payment,
      payments: [{ amount: payment }],
    });
    return reopened;
  }

  const increased = revise(3, 10);
  expect(increased.due).toBeGreaterThan(invoice.grand_total - payment);
  const decreased = revise(2, 10);
  expect(decreased.due).toBeLessThan(increased.due);
  const withoutServiceCharge = revise(2, 0);
  expect(withoutServiceCharge.due).toBeLessThan(decreased.due);
  expect(settleInvoice(cashier, invoice.id, [{ method: "CASH", amount: withoutServiceCharge.due }], {
    printReceipt: false,
  })).toMatchObject({ complete: true, due: 0 });
});

it("posts prepaid settlement parts atomically and rejects stale retries", () => {
  const { ctx, seeded } = createTestApp();
  const cashier = ctx("cashier");
  const table = getTableByCode(cashier, "01");
  openTable(cashier, { tableId: table.id });
  const order = createOrder(cashier, table.id) as { id: string };
  addItem(cashier, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
  const invoice = generateInvoice(cashier, order.id, {}) as { id: string; grand_total: number };
  settleInvoice(cashier, invoice.id, [{ method: "CASH", amount: invoice.grand_total }], { printReceipt: false });
  const [payment] = getInvoice(cashier, invoice.id).payments;
  const original = settlementDetail(cashier, payment.id) as {
    method: string; amount: number; account: string; remark: string;
  };
  const advance = Math.floor(original.amount / 2);
  const { card } = saveBooking(cashier, { cardNo: "1234", advance: advance + 10_000, mop: "CASH" }) as { card: { id: string } };
  const prepaidPart = { method: "PREPAID CARD", amount: advance, account: "", remark: "", cardNumber: "1234" };
  const remaining = { ...prepaidPart, amount: original.amount - advance };

  expect(() => updateSettlement(cashier, payment.id, {
    original, lines: [prepaidPart, { ...remaining, cardNumber: "9999" }],
  })).toThrow("Card not found");
  expect(() => updateSettlement(cashier, payment.id, { original, lines: [prepaidPart, remaining] }))
    .toThrow("Insufficient amount");
  expect(balancesFromLedger(cashier, card.id).usable).toBe(advance);
  expect(getInvoice(cashier, invoice.id).payments).toEqual([payment]);

  const lines = [{ ...remaining, method: "CASH" }, prepaidPart];
  updateSettlement(cashier, payment.id, { original, lines });
  expect(getInvoice(cashier, invoice.id).payments).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: payment.id, method: "CASH", amount: remaining.amount }),
    expect.objectContaining({ method: "MEMBER_CARD", amount: advance, member_card_id: card.id, ledger_id: expect.any(String) }),
  ]));
  expect(() => updateSettlement(cashier, payment.id, { original, lines })).toThrow("Settlement changed");
  expect(balancesFromLedger(cashier, card.id).usable).toBe(0);
});

it("replaces one settlement with four parts on its original report date", () => {
  const { ctx, seeded } = createTestApp();
  const waiter = ctx("waiter");
  const cashier = ctx("cashier");
  const table = getTableByCode(waiter, "01");
  openTable(waiter, { tableId: table.id });
  const order = createOrder(waiter, table.id) as { id: string };
  addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
  const invoice = generateInvoice(cashier, order.id) as { id: string; grand_total: number };
  settleInvoice(cashier, invoice.id, [{ method: "CASH", amount: invoice.grand_total }], { printReceipt: false });
  const payment = cashier.db.prepare("SELECT id FROM payments WHERE invoice_id = ?").get(invoice.id) as { id: string };
  cashier.db.prepare("UPDATE payments SET created_at = ? WHERE id = ?").run("2024-05-02T12:00:00.000Z", payment.id);
  const original = settlementDetail(cashier, payment.id) as {
    method: string; amount: number; account: string; remark: string;
  };
  const lines = [
    { method: "BANK TRANSFER", amount: 2000, account: "HDFC", remark: "" },
    { method: "CASH", amount: 3000, account: "Cash.", remark: "" },
    { method: "BANK TRANSFER", amount: 4000, account: "INDUS", remark: "" },
    { method: "CASH", amount: original.amount - 9000, account: "Cash.", remark: "" },
  ];

  expect(() => updateSettlement(cashier, payment.id, { original, lines: lines.slice(0, 3) })).toThrow("must add up");
  expect(settlementDetail(cashier, payment.id)).toMatchObject({ method: "CASH", amount: original.amount });
  updateSettlement(cashier, payment.id, { original, lines });
  expect(() => updateSettlement(cashier, payment.id, { original, lines })).toThrow("Settlement changed");

  const report = settlementReport(cashier, "2024-05-02", "2024-05-02", "BAR");
  expect(report.rows).toHaveLength(4);
  expect(report.rows).toEqual(expect.arrayContaining(lines.map((line) => expect.objectContaining({
    invoice_id: invoice.id,
    settled: line.amount,
    method: line.method === "BANK TRANSFER" ? "CARD" : "CASH",
    account: line.account,
    status: "PAID",
  }))));

  cashier.db.prepare("UPDATE payments SET amount = 0 WHERE invoice_id = ? AND amount = ?").run(invoice.id, 3000);
  expect(settlementReport(cashier, "2024-05-02", "2024-05-02", "BAR").rows).toHaveLength(3);
  cashier.db.prepare("UPDATE payments SET amount = 3000 WHERE invoice_id = ? AND amount = 0").run(invoice.id);

  const before = cashier.db.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id) as { amount: number };
  updateSettlement(cashier, payment.id, { original: { amount: before.amount }, amount: 1000 });
  expect(cashier.db.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id)).toEqual({ ...before, amount: 1000 });
  expect(cashier.db.prepare("SELECT COUNT(*) AS count FROM payments WHERE invoice_id = ?").get(invoice.id)).toEqual({ count: 4 });
  const filtered = settlementReport(cashier, "2024-05-02", "2024-05-02", "BAR", { mop: "CASH" });
  expect(filtered.rows).toHaveLength(2);
  expect(filtered.rows.map((row) => row.status)).toEqual(["PARTIAL", "PARTIAL"]);
});
