import { expect, it } from "vitest";
import { generateInvoice, settleInvoice } from "../src/server/services/billingService.js";
import { addItem, createOrder } from "../src/server/services/orderService.js";
import { settlementDetail, settlementReport, updateSettlement } from "../src/server/services/reportService.js";
import { getTableByCode, openTable } from "../src/server/services/tableService.js";
import { createTestApp } from "./helpers.js";

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
});
