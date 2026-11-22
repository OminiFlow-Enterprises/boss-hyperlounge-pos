import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { barOrderRights } from "../src/shared/userRights.js";
import { createApp } from "../src/server/api/app.js";
import { addItem, createOrder } from "../src/server/services/orderService.js";
import { createComplimentary } from "../src/server/services/complimentaryService.js";
import { generateInvoice } from "../src/server/services/billingService.js";
import { createStaff, listStaff, updateStaff } from "../src/server/services/staffService.js";
import { getTableByCode, openTable } from "../src/server/services/tableService.js";
import { createTestApp } from "./helpers.js";

it("limits Bar operators to adding items and sending KOTs before billing", async () => {
  const { db, hardware, ctx, seeded } = createTestApp();
  const manager = ctx("manager");
  const operator = createStaff(manager, {
    username: "baroperator",
    password: "4242",
    userRole: "OPERATOR",
  });
  updateStaff(manager, operator.id, {
    username: operator.username,
    rights: { ...barOrderRights(), "fnb.advance": true, report: true, "report.pos": true },
  });
  expect(listStaff(manager).filter((row) => row.username === operator.username)).toHaveLength(1);
  db.prepare("UPDATE staff SET rights_json = ? WHERE id = ?").run(
    JSON.stringify({ "fnb.bar": false, "fnb.nc": true, "report.pos": true }), operator.id,
  );
  const bar = getTableByCode(manager, "01");
  const other = getTableByCode(manager, "02");
  db.prepare("UPDATE dining_tables SET outlet = 'RESTAURANT' WHERE id = ?").run(other.id);

  const server = createApp({ db, hardware }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const request = (path: string, body?: object) => fetch(`http://127.0.0.1:${port}/api/${path}`, body && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await request("auth/login", { username: "baroperator", password: "4242" })).status).toBe(200);
    const { tables } = await (await request("bootstrap")).json();
    expect(tables).toContainEqual(expect.objectContaining({ id: bar.id, outlet: "BAR", has_running_order: false }));
    expect(tables.every((table: { id: string; running_total?: number }) =>
      table.id !== other.id && table.running_total === undefined,
    )).toBe(true);

    expect((await request(`tables/${other.id}/open`, {})).status).toBe(403);
    expect((await request(`tables/${bar.id}/open`, {})).status).toBe(200);
    const order = await request("orders", { tableId: bar.id });
    expect(order.status).toBe(200);
    const { id } = await order.json();
    const item = { productId: seeded.products["BAR-WH"], qty: 1 };
    expect((await request(`orders/${id}/items`, { ...item, qty: -1 })).status).toBe(400);
    expect((await request(`orders/${id}/items`, item)).status).toBe(200);
    expect((await request(`orders/${id}/send-kot`, {})).status).toBe(200);
    expect((await request(`orders/${id}/items`, item)).status).toBe(200);
    expect((await request(`orders/${id}/send-kot`, {})).status).toBe(200);

    expect(await (await request("tables")).json()).toContainEqual(expect.objectContaining({
      id: bar.id,
      has_running_order: true,
    }));
    expect((await request("reports/kots")).status).toBe(403);
    expect((await request("tables/transfer", {})).status).toBe(403);
    expect((await request("tables/item-transfer", {})).status).toBe(403);
    const estimate = await request(`orders/${id}/estimate`, { items: [item] });
    expect(estimate.status).toBe(200);
    expect(await estimate.json()).toMatchObject({ grandTotal: expect.any(Number) });
    expect(db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?").get(id))
      .toEqual({ count: 2 });
    expect((await request("invoices/generate", { orderId: id })).status).toBe(403);

    const invoice = generateInvoice(manager, id) as { id: string };
    expect(await (await request("tables")).json()).toContainEqual(expect.objectContaining({
      id: bar.id,
      status: "PAYMENT_PENDING",
    }));
    expect((await request(`tables/${bar.id}/invoice`)).status).toBe(403);
    expect((await request(`invoices/${invoice.id}/pay`, {})).status).toBe(403);
    expect((await request(`tables/${bar.id}/open`, {})).status).toBe(409);
    expect((await request(`orders/${id}/estimate`, { items: [item] })).status).toBe(409);
    expect((await request(`orders/${id}/items`, item)).status).toBe(409);
    expect((await request(`orders/${id}/send-kot`, {})).status).toBe(409);
  } finally {
    server.close();
    await once(server, "close");
    db.close();
  }
});

it("updates rights for an existing username with a legacy case-insensitive duplicate", () => {
  const { ctx, db } = createTestApp();
  try {
    const manager = ctx("manager");
    const existing = createStaff(manager, { username: "barstaff", password: "4242", userRole: "OPERATOR" });
    const duplicate = createStaff(manager, { username: "legacy", password: "4243", userRole: "OPERATOR" });
    db.prepare("UPDATE staff SET username = ? WHERE id = ?").run("BARSTAFF", duplicate.id);

    expect(updateStaff(manager, existing.id, {
      username: existing.username,
      rights: barOrderRights(),
      discount: "5.00",
    })).toMatchObject({ id: existing.id, username: "barstaff", rights: barOrderRights(), discount: "5.00" });
    expect(() => updateStaff(manager, existing.id, { username: "BARSTAFF" }))
      .toThrow("Username already exists");
    expect(listStaff(manager).find((row) => row.id === duplicate.id)?.discount).toBe("0.00");
  } finally {
    db.close();
  }
});

it("lets Advance staff punch, transfer, bill and settle outside NC", async () => {
  const { db, hardware, ctx, seeded } = createTestApp();
  const manager = ctx("manager");
  createStaff(manager, { username: "advance", password: "4242", userRole: "ADVANCE" });
  const restaurant = getTableByCode(manager, "01");
  const bar = getTableByCode(manager, "02");
  const nc = getTableByCode(manager, "03");
  const legacyCafe = getTableByCode(manager, "04");
  db.prepare("UPDATE dining_tables SET outlet = 'RESTAURANT' WHERE id = ?").run(restaurant.id);
  db.prepare("UPDATE dining_tables SET outlet = 'NC' WHERE id = ?").run(nc.id);
  db.prepare("UPDATE dining_tables SET outlet = 'CAFE' WHERE id = ?").run(legacyCafe.id);

  const server = createApp({ db, hardware }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const request = (path: string, body?: object, method = body ? "POST" : "GET") =>
      fetch(`http://127.0.0.1:${port}/api/${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    const login = await request("auth/login", { username: "advance", password: "4242" });
    expect(await login.json()).toMatchObject({ userGroup: "ADVANCE", tableTransfer: true, itemTransfer: true });
    const tables = await (await request("tables")).json();
    expect(tables).toContainEqual(expect.objectContaining({ id: restaurant.id, outlet: "RESTAURANT" }));
    expect(tables).not.toContainEqual(expect.objectContaining({ id: nc.id }));
    expect((await request(`tables/${nc.id}/open`, {})).status).toBe(403);
    expect(tables).not.toContainEqual(expect.objectContaining({ id: legacyCafe.id }));
    expect((await request(`tables/${legacyCafe.id}/open`, {})).status).toBe(403);
    expect((await request(`tables/${restaurant.id}/open`, {})).status).toBe(200);
    const order = await (await request("orders", { tableId: restaurant.id })).json();
    const item = await request(`orders/${order.id}/items`, { productId: seeded.products["FOOD-PZ"], qty: 1, outlet: "RESTAURANT" });
    expect(item.status).toBe(200);
    const { id: itemId } = await item.json();
    expect((await request(`orders/${order.id}/send-kot`, {})).status).toBe(200);
    expect((await request("tables/transfer", { fromTableId: restaurant.id, toTableId: nc.id })).status).toBe(403);
    expect((await request("tables/transfer", { fromTableId: restaurant.id, toTableId: bar.id, reason: "Move to Bar" })).status).toBe(200);
    expect((await request("tables/item-transfer", { fromTableId: bar.id, toTableId: restaurant.id, itemIds: [itemId] })).status).toBe(200);
    const restaurantOrder = await (await request("orders", { tableId: restaurant.id })).json();
    const orderId = restaurantOrder.id;
    expect((await request("invoices/preview", { orderId })).status).toBe(200);
    expect((await request("invoices/preview", { orderId, discountPct: 5 })).status).toBe(403);
    expect((await request("invoices/generate", { orderId, discount: 100 })).status).toBe(403);

    const existing = generateInvoice(manager, orderId, {
      discount: 100,
      serviceChargePct: 10,
      serviceChargeMode: "EXCLUSIVE",
    }) as { id: string; discount: number };
    const invoiceId = existing.id;
    expect((await request("invoices/generate", { orderId, invoiceId, discountPct: 0 })).status).toBe(403);
    expect((await request("invoices/generate", { orderId, invoiceId, serviceChargePct: 5 })).status).toBe(403);
    const preview = await request("invoices/preview", { orderId, invoiceId, serviceChargePct: 0 });
    expect(await preview.json()).toMatchObject({ serviceCharge: 0, discount: existing.discount });
    const bill = await request("invoices/generate", { orderId, invoiceId, serviceChargePct: 0 });
    expect(bill.status).toBe(200);
    const invoice = await bill.json();
    expect(invoice).toMatchObject({ id: invoiceId, discount: existing.discount, service_charge: 0 });
    expect((await request("invoices/generate", { orderId, invoiceId, serviceChargePct: 10 })).status).toBe(403);
    expect((await request(`invoices/${invoice.id}/print`, {})).status).toBe(200);
    expect((await request(`invoices/${invoice.id}/pay`, {
      lines: [{ method: "CASH", amount: invoice.grand_total }],
      printReceipt: false,
    })).status).toBe(200);
    expect((await request("reports/kots?outlet=RESTAURANT")).status).toBe(200);
    expect((await request("reports/bills?outlet=RESTAURANT")).status).toBe(200);
    expect((await request("reports/settlement?outlet=RESTAURANT")).status).toBe(200);
    expect((await request("reports/bills?outlet=NC")).status).toBe(403);

    const payment = db.prepare("SELECT id FROM payments WHERE invoice_id = ?").get(invoiceId) as { id: string };
    const paymentPath = `reports/settlement/${payment.id}`;
    const { method, amount, account, remark } = await (await request(paymentPath)).json();
    const updated = await request(paymentPath, {
      original: { method, amount, account, remark },
      lines: [{ method: "BANK TRANSFER", amount, account: "Main Bank", remark: "Corrected payment mode" }],
    }, "PUT");
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ method: "CARD", amount, account: "Main Bank" });
    expect((await request(paymentPath, undefined, "DELETE")).status).toBe(403);

    db.prepare("UPDATE dining_tables SET outlet = 'NC' WHERE id = ?").run(restaurant.id);
    expect((await request(paymentPath, {}, "PUT")).status).toBe(403);
  } finally {
    server.close();
    await once(server, "close");
    db.close();
  }
});

it("applies Admin report checkboxes to the group and lets Cashiers use existing complimentary accounts", async () => {
  const { db, hardware, ctx, seeded } = createTestApp();
  const manager = ctx("manager");
  for (const [username, userRole] of [
    ["reportadmin", "ADMIN"], ["firstbar", "OPERATOR"], ["secondbar", "OPERATOR"],
    ["reportadvance", "ADVANCE"], ["compcashier", "CASHIER"],
  ] as const) {
    createStaff(manager, { username, password: "4242", userRole });
  }
  const account = createComplimentary(manager, "House account");
  const table = getTableByCode(manager, "01");
  openTable(manager, { tableId: table.id });
  const { id: orderId } = createOrder(manager, table.id) as { id: string };
  addItem(manager, { orderId, productId: seeded.products["FOOD-PZ"], qty: 1 });

  const server = createApp({ db, hardware }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const request = (route: string, body?: object, method = body ? "POST" : "GET") =>
      fetch(`http://127.0.0.1:${port}/api/${route}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    const login = (username: string) => request("auth/login", { username, password: "4242" });
    expect((await login("reportadmin")).status).toBe(200);
    const options = await (await request("settings/group-reports/OPERATOR")).json();
    expect(options).toMatchObject({ "report.kot": false, "report.bill": false, "report.settlement": false });
    expect((await request("settings/group-reports/OPERATOR", { "report.bill": true }, "PUT")).status).toBe(200);
    expect((await request("settings/group-reports/ADVANCE", { "report.kot": false }, "PUT")).status).toBe(200);
    expect((await request("settings/group-reports/CASHIER", { "report.gst": false }, "PUT")).status).toBe(200);
    expect((await request("settings/group-reports/OPERATOR", { "report.gst": true }, "PUT")).status).toBe(400);

    for (const username of ["firstbar", "secondbar"]) {
      expect(await (await login(username)).json()).toMatchObject({ rights: { "report.bill": true, "report.kot": false } });
      expect((await request("reports/bills?outlet=BAR")).status).toBe(200);
      expect((await request("reports/bills?outlet=RESTAURANT")).status).toBe(403);
      expect((await request("reports/kots?outlet=BAR")).status).toBe(403);
    }

    expect((await login("reportadvance")).status).toBe(200);
    expect((await request("reports/kots?outlet=BAR")).status).toBe(403);
    expect((await request("reports/bills?outlet=BAR")).status).toBe(200);

    const cashier = await login("compcashier");
    expect(await cashier.json()).toMatchObject({ allowComplementary: true, rights: { "report.gst": false } });
    expect((await request("reports/gst")).status).toBe(403);
    expect((await request("settings/group-reports/CASHIER", { "report.gst": true }, "PUT")).status).toBe(403);
    expect((await request("complimentary", { name: "New master account" })).status).toBe(403);
    const invoice = await request("invoices/generate", {
      orderId,
      complimentary: true,
      complimentaryAccountId: account.id,
      reason: "Approved complimentary bill",
      masterPin: process.env.POS_MASTER_PIN || "0166",
    });
    expect(invoice.status).toBe(200);
    expect(await invoice.json()).toMatchObject({ complimentary_account_id: account.id, grand_total: 0 });
  } finally {
    server.close();
    await once(server, "close");
    db.close();
  }
});
