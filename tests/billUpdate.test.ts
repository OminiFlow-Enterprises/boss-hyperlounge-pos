import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createApp } from "../src/server/api/app.js";
import { blockCard, issueCard, unblockCard } from "../src/server/services/cardService.js";
import { createComplimentary } from "../src/server/services/complimentaryService.js";
import { addItem, createOrder } from "../src/server/services/orderService.js";
import { createStaff } from "../src/server/services/staffService.js";
import { createTable, getTableByCode, openTable } from "../src/server/services/tableService.js";
import { flagsPreset } from "../src/shared/userRights.js";
import { createApiClient, createTestApp } from "./helpers.js";

it("shows NC estimates by permission and lets Admin save an NC bill without a remark or PIN", async () => {
  const { ctx, db, hardware, seeded } = createTestApp();
  const manager = ctx("manager");
  createStaff(manager, { username: "ncadmin", password: "4242", userRole: "ADMIN" });
  createStaff(manager, {
    username: "nchidden", password: "4242", userRole: "ADMIN",
    flags: { ...flagsPreset("ADMIN"), hideEstimate: true },
  });
  createStaff(manager, { username: "nccashier", password: "4242", userRole: "CASHIER" });
  const account = createComplimentary(manager, "NC account");
  const table = createTable(manager, { code: "N1", outlet: "NC" });
  openTable(manager, { tableId: table.id });
  const order = createOrder(manager, table.id) as { id: string };
  addItem(manager, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 2 });

  const server = createApp({ db, hardware }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const request = createApiClient((server.address() as AddressInfo).port);
    const login = (username: string) => request("auth/login", { username, password: "4242" });
    const listedTable = async () => (await (await request("tables")).json())
      .find((row: { id: string }) => row.id === table.id);
    const bill = { orderId: order.id, complimentary: true, complimentaryAccountId: account.id };

    expect((await login("nchidden")).status).toBe(200);
    const hidden = await listedTable();
    expect(hidden.has_running_order).toBe(true);
    expect(hidden).not.toHaveProperty("net_total");
    expect(hidden).not.toHaveProperty("running_total");
    expect((await request(`orders/${order.id}/estimate`, { items: [] })).status).toBe(403);
    expect((await login("nccashier")).status).toBe(200);
    expect((await listedTable()).net_total).toBeGreaterThan(0);
    const denied = await request("invoices/generate", bill);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: expect.stringContaining("master PIN") });
    expect((await login("ncadmin")).status).toBe(200);
    const saved = await request("invoices/generate", bill);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ status: "PAID", grand_total: 0 });
  } finally {
    server.close();
    await once(server, "close");
    db.close();
  }
});

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
    const wrongPin = masterPin === "0000" ? "0001" : "0000";
    const invalidServiceUpdate = await post("generate", {
      orderId, invoiceId: invoice.id, serviceChargePct: 5, masterPin: wrongPin,
    });
    expect(invalidServiceUpdate.status).toBe(403);
    expect(await invalidServiceUpdate.json()).toMatchObject({ error: "Incorrect master PIN" });
    const serviceOnly = await post("generate", { orderId, invoiceId: invoice.id, serviceChargePct: 5 });
    expect(serviceOnly.status).toBe(200);
    expect(await serviceOnly.json()).toMatchObject({ service_charge_pct: 5, discount: invoice.discount });
    const serviceWithRemark = await post("generate", {
      orderId, invoiceId: invoice.id, serviceChargePct: 3, reason: "Guest requested a lower charge",
    });
    expect(serviceWithRemark.status).toBe(200);
    const serviceInvoice = await serviceWithRemark.json();
    expect(serviceInvoice.service_charge_pct).toBe(3);
    expect(JSON.parse(serviceInvoice.bill_details).remark).toBe("Guest requested a lower charge");

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
    expect((await post("generate", { ...changes, reason: "Corrected quantity", masterPin: wrongPin })).status).toBe(403);
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

it("lets Cashier users edit printed and settled bills with approval while blocking master and item-price changes", async () => {
  const { ctx, db, hardware, seeded } = createTestApp();
  const manager = ctx("manager");
  createStaff(manager, { username: "billcashier", password: "4242", userRole: "CASHIER" });
  createStaff(manager, { username: "pinadmin", password: "4242", userRole: "ADMIN" });
  const table = getTableByCode(manager, "01");
  openTable(manager, { tableId: table.id });
  const { id: orderId } = createOrder(manager, table.id) as { id: string };
  const food = addItem(manager, { orderId, productId: seeded.products["FOOD-PZ"], qty: 1 }) as { id: string };
  const drink = addItem(manager, { orderId, productId: seeded.products["BAR-WH"], qty: 1 }) as { id: string };

  const server = createApp({ db, hardware }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const request = createApiClient(port);

    const login = await request("auth/login", { username: "billcashier", password: "4242" });
    expect(await login.json()).toMatchObject({
      userGroup: "CASHIER",
      rights: { "master.user": false, "master.item": false, "report.settlement": true, "fnb.nc": true },
    });
    expect((await request("staff", {})).status).toBe(403);
    expect((await request("items/master")).status).toBe(403);
    expect((await request("complimentary", { name: "Blocked account" })).status).toBe(403);

    const masterPin = process.env.POS_MASTER_PIN || "0166";
    const newPin = masterPin === "7531" ? "7532" : "7531";
    expect((await request("settings/master-pin", { currentPin: masterPin, newPin }, "PUT")).status).toBe(403);
    expect((await request("settings", { master_pin_hash: "invalid" }, "PUT")).status).toBe(403);
    const discount = { orderId, discountPct: 5 };
    expect((await request("invoices/generate", { ...discount, masterPin })).status).toBe(403);
    expect((await request("invoices/generate", { ...discount, reason: "Approved discount" })).status).toBe(403);
    const bill = await request("invoices/generate", { ...discount, masterPin, reason: "Approved discount" });
    expect(bill.status).toBe(200);
    const { id: invoiceId } = await bill.json();
    expect((await request(`invoices/${invoiceId}/print`, {})).status).toBe(200);

    const priceEdit = { orderId, invoiceId, edits: [{ kind: "price", ids: [food.id], price: 10 }] };
    expect((await request("invoices/preview", priceEdit)).status).toBe(403);
    expect((await request("invoices/generate", { ...priceEdit, masterPin, reason: "Price change" })).status).toBe(403);
    expect((await request(`orders/${orderId}/bill-price`, { ids: [food.id], price: 10 })).status).toBe(403);

    const correction = await request("invoices/generate", {
      orderId, invoiceId, masterPin, reason: "Corrected quantity",
      edits: [{ kind: "qty", ids: [food.id], qty: 2 }],
    });
    expect(correction.status).toBe(200);
    const corrected = await correction.json();
    expect((await request(`invoices/${invoiceId}/pay`, {
      lines: [{ method: "CASH", amount: corrected.grand_total }],
      printReceipt: false,
    })).status).toBe(200);

    const removed = await request("invoices/generate", {
      orderId, invoiceId, masterPin, reason: "Remove incorrect item",
      edits: [{ kind: "qty", ids: [drink.id], qty: 0 }],
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ id: invoiceId, status: "PAID" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM payments WHERE invoice_id = ? AND amount = 0").get(invoiceId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT qty, voided FROM order_items WHERE id = ?").get(drink.id)).toEqual({ qty: 0, voided: 1 });

    const adminLogin = await request("auth/login", { username: "pinadmin", password: "4242" });
    expect(await adminLogin.json()).toMatchObject({ userGroup: "ADMIN", rights: { "master.user": true } });
    expect((await request("settings/master-pin", { currentPin: newPin, newPin }, "PUT")).status).toBe(403);
    expect((await request("settings/master-pin", { currentPin: masterPin, newPin }, "PUT")).status).toBe(200);
    expect(await (await request("settings")).json()).not.toHaveProperty("master_pin_hash");
    expect((await request("auth/login", { username: "billcashier", password: "4242" })).status).toBe(200);
    const revisedDiscount = { orderId, invoiceId, discountPct: 8, reason: "Approved discount update" };
    expect((await request("invoices/generate", { ...revisedDiscount, masterPin })).status).toBe(403);
    expect((await request("invoices/generate", { ...revisedDiscount, masterPin: newPin })).status).toBe(200);
  } finally {
    server.close();
    await once(server, "close");
    db.close();
  }
});
