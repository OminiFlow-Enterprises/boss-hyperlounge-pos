import { describe, expect, it } from "vitest";
import { rupeesToPaise } from "../src/shared/money.js";
import { openTable, transferTable, mergeTables, getTableByCode, splitTable, createTable, transferItems, listTables } from "../src/server/services/tableService.js";
import { addItem, createOrder, sendKot, getOrderDetail, reprintKot, setBillLineQty, setBillLineProduct, setBillLinePrice } from "../src/server/services/orderService.js";
import { generateInvoice, settleInvoice, previewBill, cardSpendable, settleClubFromCard } from "../src/server/services/billingService.js";
import { issueCard, rechargeCard, checkBalance } from "../src/server/services/cardService.js";
import { InsufficientBalanceError } from "../src/server/lib/errors.js";
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
    expect(bill.foodTotal).toBe(rupeesToPaise(600));
    expect(bill.drinksTotal).toBe(rupeesToPaise(300));
    expect(bill.grandTotal).toBe(rupeesToPaise(984));
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

  it("transfers selected items onto another table", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const a = getTableByCode(waiter, "01");
    const dest = getTableByCode(waiter, "05");
    openTable(waiter, { tableId: a.id });
    const order = createOrder(waiter, a.id) as { id: string };
    const pizza = addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 }) as { id: string };
    const whisky = addItem(waiter, { orderId: order.id, productId: seeded.products["BAR-WH"], qty: 1 }) as { id: string };
    await sendKot(waiter, order.id);
    transferItems(waiter, a.id, dest.id, [pizza.id], "move pizza");
    expect(getTableByCode(waiter, "01").status).toBe("OCCUPIED");
    expect(getTableByCode(waiter, "05").status).toBe("OCCUPIED");
    const destOrder = createOrder(waiter, dest.id) as { id: string };
    const destItems = getOrderDetail(waiter, destOrder.id).items as Array<{ id: string }>;
    expect(destItems.map((i) => i.id)).toContain(pizza.id);
    transferItems(waiter, a.id, dest.id, [whisky.id]);
    expect(getTableByCode(waiter, "01").status).toBe("AVAILABLE");
    expect(getOrderDetail(waiter, destOrder.id).items as Array<{ id: string }>).toHaveLength(2);
  });

  it("requires settlement before moving a printed bill's table or items in either direction", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    const first = getTableByCode(waiter, "01");
    const second = getTableByCode(waiter, "05");
    openTable(waiter, { tableId: first.id });
    openTable(waiter, { tableId: second.id });
    const order = createOrder(waiter, first.id) as { id: string };
    const item = addItem(waiter, {
      orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1,
    }) as { id: string };
    await sendKot(waiter, order.id);
    generateInvoice(cashier, order.id);

    for (const [from, to] of [[first, second], [second, first]]) {
      expect(() => transferTable(waiter, from.id, to.id, "Move table")).toThrow("Settlement pending");
      expect(() => transferItems(waiter, from.id, to.id, [item.id])).toThrow("Settlement pending");
      expect(() => mergeTables(waiter, from.id, to.id)).toThrow("Settlement pending");
    }
    expect(getTableByCode(waiter, "01").status).toBe("PAYMENT_PENDING");
    expect(getOrderDetail(waiter, order.id).items).toHaveLength(1);
  });

  it("rejects member-card settlement when the card balance is too low", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const card = issueCard(cashier, {
      customer: { name: "Low Bal", mobile: "9000000001" },
      cardNumber: "LOW-1",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(150), paymentMode: "CASH", applyBonus: false });
    const table = getTableByCode(waiter, "06");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const invoice = generateInvoice(cashier, order.id) as { id: string; grand_total: number };
    expect(() =>
      settleInvoice(cashier, invoice.id, [{ method: "MEMBER_CARD", amount: invoice.grand_total, memberCardId: card.id }]),
    ).toThrow(InsufficientBalanceError);
  });

  it("takes the card balance when it is less than the bill and the bill amount when the card is larger", () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const short = issueCard(cashier, {
      customer: { name: "Short Card", mobile: "9000000711" },
      cardNumber: "SHORT-1",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: short.id, amount: rupeesToPaise(1100), paymentMode: "CASH", applyBonus: false });
    const table = getTableByCode(waiter, "07");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 4 });
    const invoice = generateInvoice(cashier, order.id) as { id: string; grand_total: number };
    expect(invoice.grand_total).toBeGreaterThan(rupeesToPaise(1000));
    const part = settleInvoice(cashier, invoice.id, [{ method: "MEMBER_CARD", amount: rupeesToPaise(1000), memberCardId: short.id }]);
    expect(part.complete).toBe(false);
    expect(part.due).toBe(invoice.grand_total - rupeesToPaise(1000));
    expect(checkBalance(cashier, "SHORT-1").balances.usable).toBe(0);

    const rich = issueCard(cashier, {
      customer: { name: "Rich Card", mobile: "9000000712" },
      cardNumber: "RICH-1",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: rich.id, amount: rupeesToPaise(4100), paymentMode: "CASH", applyBonus: false });
    const rest = settleInvoice(cashier, invoice.id, [{ method: "MEMBER_CARD", amount: rupeesToPaise(1000), memberCardId: rich.id }]);
    expect(rest.due).toBe(invoice.grand_total - rupeesToPaise(2000));
    expect(checkBalance(cashier, "RICH-1").balances.usable).toBe(rupeesToPaise(3000));
  });

  it("shows the bill net amount on the table estimate", () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "10");
    const table = getTableByCode(waiter, "02");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const bill = previewBill(cashier, order.id, { serviceChargePct: 10, discountPct: 0 });
    const row = (listTables(cashier) as Array<{ code: string; running_total: number; net_total: number }>)
      .find((t) => t.code === "02");
    expect(row?.net_total).toBe(bill.grandTotal);
    expect(row?.net_total).not.toBe(row?.running_total);
  });

  it("keeps BAR and RESTAURANT running tables on separate tabs", () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const bar = getTableByCode(waiter, "01", "BAR");
    openTable(waiter, { tableId: bar.id, outlet: "BAR" });
    const barOrder = createOrder(waiter, bar.id) as { id: string };
    addItem(waiter, { orderId: barOrder.id, productId: seeded.products["BAR-WH"], qty: 1 });
    const rest = createTable(waiter, { code: "01", outlet: "RESTAURANT" });
    openTable(waiter, { tableId: rest.id, outlet: "RESTAURANT" });
    const restOrder = createOrder(waiter, rest.id) as { id: string };
    addItem(waiter, { orderId: restOrder.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const list = listTables(waiter) as Array<{ id: string; code: string; outlet: string; status: string }>;
    expect(list.find((t) => t.code === "01" && t.outlet === "BAR")?.status).toBe("OCCUPIED");
    expect(list.find((t) => t.code === "01" && t.outlet === "RESTAURANT")?.status).toBe("OCCUPIED");
    expect(bar.id).not.toBe(rest.id);
  });

  it("updates a printed bill when discount or service changes", () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const table = getTableByCode(waiter, "03");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const first = generateInvoice(cashier, order.id) as { id: string; grand_total: number; discount: number };
    const again = generateInvoice(cashier, order.id, { discountPct: 10, discountFrom: "percent" }) as { id: string; grand_total: number; discount: number };
    expect(again.id).toBe(first.id);
    expect(again.discount).toBeGreaterThan(0);
    expect(again.grand_total).toBeLessThan(first.grand_total);
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
    const done = settleInvoice(cashier, invoice.id, [{ method: "PAYTM", amount: invoice.grand_total - rupeesToPaise(200) }]);
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

  it("punches -1 qty to reduce a sent item and prints a cancel KOT", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const table = getTableByCode(waiter, "03");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 2 });
    await sendKot(waiter, order.id);
    addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: -1 });
    const kots = await sendKot(waiter, order.id);
    expect(kots.some((k) => k.type === "CANCEL")).toBe(true);
    const detail = getOrderDetail(waiter, order.id);
    const live = (detail.items as Array<{ voided: number; qty: number; kot_id: string | null }>).filter((i) => !i.voided);
    expect(live).toHaveLength(1);
    expect(live[0].qty).toBe(1);
    expect(live[0].kot_id).toBeTruthy();
  });

  it("edits a printed bill qty and still accepts another item", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const table = getTableByCode(waiter, "04");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    const line = addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 2 }) as { id: string };
    await sendKot(waiter, order.id);
    const first = generateInvoice(cashier, order.id, { serviceChargePct: 0, discountPct: 0 }) as { id: string };
    setBillLineQty(cashier, order.id, [line.id], 1);
    addItem(cashier, { orderId: order.id, productId: seeded.products["BAR-WH"], qty: 1 });
    const bill = previewBill(cashier, order.id, { serviceChargePct: 0, discountPct: 0 });
    expect(bill.foodTotal).toBe(rupeesToPaise(600));
    expect(bill.drinksTotal).toBe(rupeesToPaise(300));
    const again = generateInvoice(cashier, order.id, { serviceChargePct: 0, discountPct: 0 }) as { id: string; grand_total: number };
    expect(again.id).toBe(first.id);
    expect(again.grand_total).toBe(bill.grandTotal);
  });

  it("replaces the item on a printed bill line", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const table = getTableByCode(waiter, "06");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    const line = addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 2 }) as { id: string };
    await sendKot(waiter, order.id);
    generateInvoice(cashier, order.id, { serviceChargePct: 0, discountPct: 0 });
    setBillLineProduct(cashier, order.id, [line.id], seeded.products["BAR-WH"]);
    const bill = previewBill(cashier, order.id, { serviceChargePct: 0, discountPct: 0 });
    expect(bill.foodTotal).toBe(0);
    expect(bill.drinksTotal).toBe(rupeesToPaise(600));
    expect(bill.totalQty).toBe(2);
  });

  it("changes the price on a printed bill line", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const table = getTableByCode(waiter, "07");
    openTable(waiter, { tableId: table.id });
    const order = createOrder(waiter, table.id) as { id: string };
    const line = addItem(waiter, { orderId: order.id, productId: seeded.products["FOOD-PZ"], qty: 2 }) as { id: string };
    await sendKot(waiter, order.id);
    const first = generateInvoice(cashier, order.id, { serviceChargePct: 0, discountPct: 0 }) as { id: string };
    setBillLinePrice(cashier, order.id, [line.id], rupeesToPaise(100));
    const bill = previewBill(cashier, order.id, { serviceChargePct: 0, discountPct: 0 });
    expect(bill.items[0]?.unit_price).toBe(rupeesToPaise(100));
    expect(bill.foodTotal).toBe(rupeesToPaise(200));
    const again = generateInvoice(cashier, order.id, { serviceChargePct: 0, discountPct: 0 }) as { id: string; grand_total: number };
    expect(again.id).toBe(first.id);
    expect(again.grand_total).toBe(bill.grandTotal);
  });

  it("deducts the Boss Club card when the order is punched and does not charge it again", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const card = issueCard(cashier, {
      customer: { name: "Club Guest", mobile: "9000001001" },
      cardNumber: "1001",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(2000), paymentMode: "CASH", applyBonus: false });

    const club = createTable(waiter, { code: "C1", outlet: "THE BOSS CLUB" });
    openTable(waiter, { tableId: club.id, cardId: card.id });
    const clubOrder = createOrder(waiter, club.id) as { id: string };
    addItem(waiter, { orderId: clubOrder.id, productId: seeded.products["FOOD-PZ"], qty: 1 });
    const clubNet = previewBill(cashier, clubOrder.id, { serviceChargePct: 0 }).grandTotal;
    expect(checkBalance(cashier, "1001").balances.usable).toBe(rupeesToPaise(1900));
    await sendKot(waiter, clubOrder.id);
    const afterPunch = checkBalance(cashier, "1001").balances.usable;
    expect(afterPunch).toBe(rupeesToPaise(1900) - clubNet);

    const rest = createTable(waiter, { code: "R1", outlet: "RESTAURANT" });
    openTable(waiter, { tableId: rest.id });
    const restOrder = createOrder(waiter, rest.id) as { id: string };
    addItem(waiter, { orderId: restOrder.id, productId: seeded.products["FOOD-PZ"], qty: 4 });
    const invoice = generateInvoice(cashier, restOrder.id, { serviceChargePct: 0 }) as { id: string; grand_total: number };
    expect(invoice.grand_total).toBeGreaterThan(afterPunch);
    expect(() =>
      settleInvoice(cashier, invoice.id, [{ method: "MEMBER_CARD", amount: invoice.grand_total, memberCardId: card.id }]),
    ).toThrow(InsufficientBalanceError);

    const part = settleInvoice(cashier, invoice.id, [{ method: "MEMBER_CARD", amount: afterPunch, memberCardId: card.id }]);
    expect(part.complete).toBe(false);
    expect(cardSpendable(cashier, card.id).usable).toBe(0);

    const beforeClubSettle = checkBalance(cashier, "1001").balances.usable;
    const clubPaid = settleClubFromCard(cashier, (generateInvoice(cashier, clubOrder.id, { serviceChargePct: 0 }) as { id: string }).id);
    expect(clubPaid.complete).toBe(true);
    expect(checkBalance(cashier, "1001").balances.usable).toBe(beforeClubSettle);
  });

  it("puts the Boss Club card balance back when the punched item is cancelled", async () => {
    const { seeded, ctx } = createTestApp();
    const waiter = ctx("waiter");
    const cashier = ctx("cashier");
    setSetting(cashier, "service_charge_pct", "0");
    const card = issueCard(cashier, {
      customer: { name: "Club Guest", mobile: "9000001002" },
      cardNumber: "1002",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(2000), paymentMode: "CASH", applyBonus: false });
    const club = createTable(waiter, { code: "C2", outlet: "THE BOSS CLUB" });
    openTable(waiter, { tableId: club.id, cardId: card.id });
    const clubOrder = createOrder(waiter, club.id) as { id: string };
    const line = addItem(waiter, { orderId: clubOrder.id, productId: seeded.products["FOOD-PZ"], qty: 2 }) as { id: string };
    await sendKot(waiter, clubOrder.id);
    const net2 = previewBill(cashier, clubOrder.id, { serviceChargePct: 0 }).grandTotal;
    expect(checkBalance(cashier, "1002").balances.usable).toBe(rupeesToPaise(1900) - net2);
    setBillLineQty(cashier, clubOrder.id, [line.id], 1);
    const net1 = previewBill(cashier, clubOrder.id, { serviceChargePct: 0 }).grandTotal;
    expect(checkBalance(cashier, "1002").balances.usable).toBe(rupeesToPaise(1900) - net1);
    setBillLineQty(cashier, clubOrder.id, [line.id], 0);
    expect(checkBalance(cashier, "1002").balances.usable).toBe(rupeesToPaise(1900));
  });

  it("creates a new table from a typed code and reuses the same code", () => {
    const { ctx } = createTestApp();
    const cashier = ctx("cashier");
    const created = createTable(cashier, { code: "99", name: "Table 99" }) as { id: string; code: string };
    expect(created.code).toBe("99");
    const again = createTable(cashier, { code: "99" }) as { id: string };
    expect(again.id).toBe(created.id);
    expect(getTableByCode(cashier, "99").id).toBe(created.id);
  });
});
