import { expect, it } from "vitest";
import { addItem, createOrder, reprintKot, sendKot } from "../src/server/services/orderService.js";
import { getTableByCode, openTable } from "../src/server/services/tableService.js";
import { createKotPrintWorker, getKotPrintJob } from "../src/server/services/kotPrintQueue.js";
import { createTestApp } from "./helpers.js";

it.each(["THE BOSS CLUB", "RESTAURANT"])("routes original and customer KOT copies for %s", async (outlet) => {
  const { db, seeded, ctx, hardware } = createTestApp();
  const cashier = ctx("cashier");
  const table = getTableByCode(cashier, "01");
  db.prepare("UPDATE dining_tables SET outlet = ? WHERE id = ?").run(outlet, table.id);
  openTable(cashier, { tableId: table.id });
  const order = createOrder(cashier, table.id) as { id: string };
  const drink = seeded.products["BAR-CK"];
  const food = seeded.products["FOOD-PZ"];
  const setGroup = db.prepare("UPDATE products SET item_group = ?, name = ? WHERE id = ?");
  setGroup.run("EV CAFE", "LOCAL DRINK", drink);
  setGroup.run(outlet === "RESTAURANT" ? "FOOD" : "EV FOOD", "KITCHEN FOOD", food);
  addItem(cashier, { orderId: order.id, productId: drink, qty: 1 });
  addItem(cashier, { orderId: order.id, productId: food, qty: 1 });

  const tickets = await sendKot(cashier, order.id, { queuePrinting: true });
  const ids = tickets.flatMap((ticket) => ticket.printJobIds ?? []);
  expect(ids).toHaveLength(4);
  await createKotPrintWorker(db, hardware)();
  const localHtml = ids
    .filter((id) => (getKotPrintJob(db, id) as { destination: string }).destination === "CONNECTED")
    .map((id) => getKotPrintJob(db, id, "claim"));
  expect(localHtml).toEqual(expect.arrayContaining([
    expect.objectContaining({ deviceName: "", html: expect.stringMatching(/Original Copy[\s\S]*LOCAL DRINK/) }),
    expect.objectContaining({ deviceName: "", html: expect.stringMatching(/Customer Copy[\s\S]*LOCAL DRINK/) }),
    expect.objectContaining({ deviceName: "", html: expect.stringMatching(/Customer Copy[\s\S]*KITCHEN FOOD/) }),
  ]));
  expect(hardware.kitchen.logs).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ items: [expect.objectContaining({ name: "KITCHEN FOOD" })] }) }),
  ]);
  expect(hardware.bar.logs).toHaveLength(0);
  expect(hardware.cafeBar.logs).toHaveLength(0);
  const reprints = await Promise.all(tickets.map((ticket) => reprintKot(cashier, ticket.id)));
  expect(reprints.flatMap((result) => result.clientPrintHtml)).toHaveLength(3);
  expect(hardware.kitchen.logs).toHaveLength(2);
});

it("prints only the assigned items at each queue and applies the same routing on reprint", async () => {
  const { db, seeded, ctx, hardware } = createTestApp();
  const cashier = { ...ctx("cashier"), officeTerminal: true };
  const table = getTableByCode(cashier, "01");
  openTable(cashier, { tableId: table.id });
  const order = createOrder(cashier, table.id) as { id: string };
  const routes = [
    { sku: "FOOD-PZ", group: "FOOD", printer: hardware.kitchen },
    { sku: "BAR-WH", group: "BAR", printer: hardware.bar },
    { sku: "FOOD-PT", group: "BEVERAGE", printer: hardware.cafeBar },
  ];
  const setGroup = db.prepare("UPDATE products SET item_group = ?, name = ? WHERE id = ?");
  for (const { sku, group } of routes) {
    const productId = seeded.products[sku];
    setGroup.run(group, sku, productId);
    addItem(cashier, { orderId: order.id, productId, qty: 1 });
  }
  const connectedProduct = seeded.products["BAR-CK"];
  const officeProduct = seeded.products["FOOD-FF"];
  setGroup.run("SPL", "OFFICE-SLIP", officeProduct);
  addItem(cashier, { orderId: order.id, productId: officeProduct, qty: 1 });
  setGroup.run("SPL1", "LOCAL-SLIP", connectedProduct);
  addItem(cashier, { orderId: order.id, productId: connectedProduct, qty: 1 });

  const tickets = await sendKot(cashier, order.id);
  const localSlips = tickets.flatMap((ticket) => ticket.print?.clientPrintHtml ?? []);
  expect(localSlips).toEqual([expect.stringContaining("LOCAL-SLIP")]);
  expect(tickets.flatMap((ticket) => ticket.print?.officePrintHtml ?? [])).toEqual([expect.stringContaining("OFFICE-SLIP")]);
  const reprints = await Promise.all(tickets.map((ticket) => reprintKot(cashier, ticket.id)));
  expect(reprints.every((result) => result.ok)).toBe(true);
  expect(reprints.flatMap((result) => result.clientPrintHtml)).toEqual([expect.stringContaining("LOCAL-SLIP")]);
  expect(reprints.flatMap((result) => result.officePrintHtml)).toEqual([expect.stringContaining("OFFICE-SLIP")]);
  expect(hardware.receipt.logs).toHaveLength(0);

  for (const { sku, printer } of routes) {
    expect(printer.logs.map(({ kind, payload, reprint }) => ({ kind, payload, reprint }))).toEqual([
      { kind: "kot", payload: expect.objectContaining({ items: [expect.objectContaining({ name: sku })] }), reprint: false },
      { kind: "kot", payload: expect.objectContaining({ items: [expect.objectContaining({ name: sku })] }), reprint: true },
    ]);
  }
});

it("queues SPL only for the Office PC and sends that terminal the local bill queue", async () => {
  const { db, seeded, ctx, hardware } = createTestApp();
  const cashier = ctx("cashier");
  const office = { ...cashier, officeTerminal: true };
  const table = getTableByCode(cashier, "01");
  openTable(cashier, { tableId: table.id });
  const order = createOrder(cashier, table.id) as { id: string };
  const productId = seeded.products["FOOD-FF"];
  db.prepare("UPDATE products SET item_group = 'SPL', name = 'Office item' WHERE id = ?").run(productId);
  addItem(cashier, { orderId: order.id, productId, qty: 1 });
  const [other] = await sendKot(cashier, order.id, { queuePrinting: true });
  expect(other.printJobIds).toEqual([]);
  expect(db.prepare("SELECT qty FROM kot_items WHERE kot_id = ?").pluck().get(other.id)).toBe(1);

  addItem(office, { orderId: order.id, productId, qty: 1 });
  const [ticket] = await sendKot(office, order.id, { queuePrinting: true });
  const [jobId] = ticket.printJobIds ?? [];
  expect(jobId).toBeTruthy();
  await createKotPrintWorker(db, hardware)();
  expect(() => getKotPrintJob(db, jobId, "claim")).toThrow("Print job not found");
  expect(getKotPrintJob(db, jobId, "claim", undefined, true)).toMatchObject({
    deviceName: "bill", html: expect.stringContaining("OFFICE ITEM"),
  });
  expect(getKotPrintJob(db, jobId, "finish", null, true)).toMatchObject({ status: "PRINTED" });
  expect(hardware.receipt.logs).toHaveLength(0);
});

it("saves jobs before printing and tracks failures and connected printer claims", async () => {
  const { db, seeded, ctx, hardware } = createTestApp();
  const cashier = ctx("cashier");
  const table = getTableByCode(cashier, "01");
  openTable(cashier, { tableId: table.id });
  const order = createOrder(cashier, table.id) as { id: string };
  const cafe = seeded.products["FOOD-PT"];
  const connected = seeded.products["BAR-CK"];
  const setGroup = db.prepare("UPDATE products SET item_group = ? WHERE id = ?");
  setGroup.run("BEVERAGE", cafe);
  setGroup.run("SPL1", connected);
  for (const productId of [seeded.products["FOOD-PZ"], cafe, connected]) {
    addItem(cashier, { orderId: order.id, productId, qty: 1 });
  }

  const tickets = await sendKot(cashier, order.id, { queuePrinting: true });
  const ids = tickets.flatMap((ticket) => ticket.printJobIds ?? []);
  expect(ids).toHaveLength(3);
  expect(hardware.kitchen.logs).toHaveLength(0);
  for (const id of ids) expect(getKotPrintJob(db, id)).toMatchObject({ status: "QUEUED" });

  hardware.cafeBar.failNext = true;
  const tick = createKotPrintWorker(db, hardware);
  await tick();
  expect(ids.map((id) => getKotPrintJob(db, id))).toEqual(expect.arrayContaining([
    expect.objectContaining({ destination: "KITCHEN", status: "PRINTED" }),
    expect.objectContaining({ destination: "CAFE BAR", status: "FAILED", error: "CAFE BAR offline" }),
    expect.objectContaining({ destination: "CONNECTED", status: "QUEUED" }),
  ]));
  const connectedId = ids.find((id) => (getKotPrintJob(db, id) as { destination: string }).destination === "CONNECTED")!;
  expect(getKotPrintJob(db, connectedId, "claim")).toMatchObject({ html: expect.stringContaining("CONNECTED") });
  expect(getKotPrintJob(db, connectedId, "claim")).not.toHaveProperty("html");
  expect(getKotPrintJob(db, connectedId, "finish", "Printer disconnected")).toMatchObject({ status: "FAILED" });
  await tick();
  expect(hardware.kitchen.logs).toHaveLength(1);
});
