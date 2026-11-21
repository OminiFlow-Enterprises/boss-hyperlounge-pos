import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";
import { createTable, getTable, openTable } from "../src/server/services/tableService.js";
import { addItem, createOrder, sendKot } from "../src/server/services/orderService.js";
import { generateInvoice } from "../src/server/services/billingService.js";
import { billReport, kotReport, settlementReport } from "../src/server/services/reportService.js";
import {
  createComplimentary,
  deleteComplimentary,
  updateComplimentary,
} from "../src/server/services/complimentaryService.js";

describe("NC complimentary bills", () => {
  it("saves a zero bill with an account and skips settlement", async () => {
    const { ctx, seeded } = createTestApp();
    const cashier = ctx();
    expect(() => createComplimentary(cashier, "  ")).toThrow(/Name is required/);
    const first = createComplimentary(cashier, "ASHU BHAIYA");
    const second = createComplimentary(cashier, "BAR STAFF");
    expect(first.code).toBe(1);
    expect(second.code).toBe(2);
    const edited = updateComplimentary(cashier, first.id, "ASHU BHAIYA JI");
    expect(edited.name).toBe("ASHU BHAIYA JI");

    const table = createTable(cashier, { code: "N1", outlet: "NC" });
    openTable(cashier, { tableId: table.id });
    const order = createOrder(cashier, table.id) as { id: string };
    addItem(cashier, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 2 });
    await sendKot(cashier, order.id, { remark: "nc kot" });

    expect(() => generateInvoice(cashier, order.id, {})).toThrow(/Complimentary A\/C/);

    const invoice = generateInvoice(cashier, order.id, { complimentaryAccountId: edited.id }) as {
      grand_total: number;
      status: string;
      complimentary_name: string;
      tax: number;
      food_total: number;
      drinks_total: number;
      service_charge: number;
      id: string;
    };
    expect(invoice.grand_total).toBe(0);
    expect(invoice.food_total).toBe(0);
    expect(invoice.drinks_total).toBe(0);
    expect(invoice.tax).toBe(0);
    expect(invoice.service_charge).toBe(0);
    expect(invoice.status).toBe("PAID");
    expect(invoice.complimentary_name).toBe("ASHU BHAIYA JI");

    const lines = cashier.db.prepare("SELECT amount, unit_price, qty FROM invoice_items WHERE invoice_id = ?").all(invoice.id) as Array<{
      amount: number;
      unit_price: number;
      qty: number;
    }>;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.amount === 0 && line.unit_price > 0 && line.qty > 0)).toBe(true);
    const payments = cashier.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?").get(invoice.id) as { n: number };
    expect(payments.n).toBe(0);
    expect(getTable(cashier, table.id).status).toBe("AVAILABLE");

    const bills = billReport(cashier, undefined, undefined, { outlet: "NC" });
    const billRows = bills.rows as Array<{ invoice_id?: string; net_amount: number; remark: string }>;
    expect(billRows.some((row) => row.invoice_id === invoice.id && row.net_amount === 0 && row.remark === "ASHU BHAIYA JI")).toBe(true);

    const regularTable = createTable(cashier, { code: "R1", outlet: "BAR" });
    openTable(cashier, { tableId: regularTable.id });
    const regularOrder = createOrder(cashier, regularTable.id) as { id: string };
    addItem(cashier, { orderId: regularOrder.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    generateInvoice(cashier, regularOrder.id, {});

    const matchingBill = { invoice_id: invoice.id, complimentary_account: edited.name };
    expect(billReport(cashier, undefined, undefined, { complimentaryAccountId: edited.id }).rows).toEqual([
      expect.objectContaining(matchingBill),
    ]);
    expect(billReport(cashier, undefined, undefined, { complimentaryAccountId: second.id }).rows).toEqual([]);
    expect(billReport(cashier, undefined, undefined, { complimentaryOnly: true }).rows).toEqual([
      expect.objectContaining(matchingBill),
    ]);
    expect(billReport(cashier, undefined, undefined, { complimentaryAccount: "ashu bhaiya" }).rows).toEqual([
      expect.objectContaining(matchingBill),
    ]);
    expect(billReport(cashier, undefined, undefined, { complimentaryAccount: "001" }).rows).toEqual([
      expect.objectContaining(matchingBill),
    ]);
    expect(billReport(cashier, undefined, undefined, { complimentaryAccount: "BAR STAFF" }).rows).toEqual([]);
    deleteComplimentary(cashier, edited.id);
    expect(billReport(cashier, undefined, undefined, { complimentaryAccount: "ashu bhaiya" }).rows).toEqual([
      expect.objectContaining(matchingBill),
    ]);

    const kots = kotReport(cashier, undefined, undefined, undefined, { outlet: "NC" });
    expect(kots.rows.length).toBeGreaterThan(0);
    const settled = settlementReport(cashier, undefined, undefined, "NC");
    expect(settled.rows.some((row) => row.invoice_id === invoice.id)).toBe(false);

    deleteComplimentary(cashier, second.id);
    expect(() => updateComplimentary(cashier, second.id, "GONE")).toThrow(/not found/);
  });
});
