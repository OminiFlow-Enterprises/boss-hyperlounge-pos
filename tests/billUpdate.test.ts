import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createApp } from "../src/server/api/app.js";
import { blockCard, issueCard, unblockCard } from "../src/server/services/cardService.js";
import { addItem, createOrder } from "../src/server/services/orderService.js";
import { getTableByCode, openTable } from "../src/server/services/tableService.js";
import { createTestApp } from "./helpers.js";

it("estimates draft items with billing totals and stops orders and bills for blocked cards", async () => {
  const { ctx, db, hardware, seeded } = createTestApp();
  const manager = ctx("manager");
  const card = issueCard(manager, {
    cardNumber: "4001",
    cardTypeCode: "REGULAR",
    customer: { name: "Test Guest", mobile: "9000004001" },
  });
  const table = getTableByCode(manager, "01");
  openTable(manager, { tableId: table.id, cardId: card.id });
  const { id: orderId } = createOrder(manager, table.id) as { id: string };
  const item = { productId: seeded.products["FOOD-PZ"], qty: 1 };
  const server = createApp({ db, hardware }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    function post(path: string, body: object) {
      return fetch(`http://127.0.0.1:${port}/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    const estimate = await post(`orders/${orderId}/estimate`, { items: [item] });
    expect(estimate.status).toBe(200);
    const { grandTotal } = await estimate.json();
    expect(db.prepare("SELECT id FROM order_items WHERE order_id = ?").get(orderId)).toBeUndefined();
    expect((await post(`orders/${orderId}/items`, item)).status).toBe(200);
    const preview = await post("invoices/preview", { orderId });
    expect(await preview.json()).toMatchObject({
      grandTotal,
      tax: expect.any(Number),
      serviceCharge: expect.any(Number),
    });

    blockCard(manager, card.id, "Customer request");
    const blockedOrder = await post(`orders/${orderId}/items`, item);
    expect(blockedOrder.status).toBe(409);
    expect(await blockedOrder.json()).toMatchObject({ code: "CARD_BLOCKED" });
    expect((await post(`orders/${orderId}/send-kot`, {})).status).toBe(409);
    expect((await post("invoices/generate", { orderId })).status).toBe(409);

    unblockCard(manager, card.id, "Cleared");
    const bill = await post("invoices/generate", { orderId });
    expect(bill.status).toBe(200);
    expect(await bill.json()).toMatchObject({ grand_total: grandTotal });
  } finally {
    server.close();
    db.close();
  }
});

it("previews bill edits without saving and requires the PIN to update only the selected bill", async () => {
  const { ctx, db, hardware, seeded } = createTestApp();
  const waiter = ctx("waiter");
  const productId = seeded.products["FOOD-PZ"];
  function orderFor(code: string) {
    const table = getTableByCode(waiter, code);
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    const item = addItem(waiter, { orderId: order.id, productId, qty: 1 }) as { id: string };
    return { orderId: order.id, itemId: item.id };
  }
  const { orderId, itemId } = orderFor("01");
  const server = createApp({ db, hardware }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    function post(action: string, body: object) {
      return fetch(`http://127.0.0.1:${port}/api/invoices/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    const masterPin = process.env.POS_MASTER_PIN || "0166";
    const original = await post("generate", { orderId, discountPct: 5, reason: "Initial discount", masterPin });
    expect(original.status).toBe(200);
    const invoice = await original.json();
    expect(invoice.service_charge_pct).toBe(10);
    const serviceOnly = await post("generate", { orderId, invoiceId: invoice.id, serviceChargePct: 5 });
    expect(serviceOnly.status).toBe(200);
    expect(await serviceOnly.json()).toMatchObject({ service_charge_pct: 5, discount: invoice.discount });

    const changes = {
      orderId,
      invoiceId: invoice.id,
      serviceChargePct: 0,
      discountPct: 12,
      billDetails: { discountPct: 12 },
      customerDisplayName: "New guest",
      edits: [{ kind: "qty", ids: [itemId], qty: 2 }],
    };
    const preview = await post("preview", changes);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ serviceChargePct: 0, totalQty: 2 });
    expect((await post("generate", changes)).status).toBe(403);
    const missingRemark = await post("generate", { ...changes, masterPin, reason: "  " });
    expect(missingRemark.status).toBe(403);
    expect(await missingRemark.json()).toMatchObject({ code: "BILL_REMARK_REQUIRED" });
    expect((await post("generate", { ...changes, reason: "Corrected quantity", masterPin: "0000" })).status).toBe(403);
    expect(db.prepare("SELECT qty FROM order_items WHERE id = ?").get(itemId)).toEqual({ qty: 1 });

    const update = await post("generate", { ...changes, reason: "Corrected quantity", masterPin });
    expect(update.status).toBe(200);
    const updated = await update.json();
    expect(updated).toMatchObject({
      id: invoice.id, service_charge_pct: 0, customer_display_name: "New guest",
    });
    expect(updated.discount).not.toBe(invoice.discount);
    expect(JSON.parse(updated.bill_details).remark).toBe("Corrected quantity");
    expect(updated.grand_total).not.toBe(invoice.grand_total);
    const receipt = await post(`${invoice.id}/print`, {});
    expect(receipt.status).toBe(200);
    const { html } = await receipt.json();
    expect(html).toMatch(/class="words"[^\n]+\s+<div class="bill-remark"><strong>Remark:<\/strong> Corrected quantity<\/div>\s+<div class="thanks"/);
    expect(html).toContain("Discount 12.00 %");
    expect(html).not.toContain("Discount 5.00 %");
    expect(html).toMatch(new RegExp(`Discount 12\\.00 %[\\s\\S]*?<div class="amt">${(updated.discount / 100).toFixed(2).replace(".", "\\.")}</div>`));
    expect(html).toContain(`<div class="amt">${(updated.grand_total / 100).toFixed(2)}</div>`);
    expect(db.prepare("SELECT qty FROM invoice_items WHERE invoice_id = ?").get(invoice.id)).toEqual({ qty: 2 });
    const next = await post("generate", { orderId: orderFor("02").orderId, serviceChargePct: 0 });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ service_charge_pct: 0 });
  } finally {
    server.close();
    db.close();
  }
});
