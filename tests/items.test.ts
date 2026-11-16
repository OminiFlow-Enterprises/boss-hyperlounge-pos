import { describe, expect, it } from "vitest";
import { rupeesToPaise } from "../src/shared/money.js";
import { createItem, deleteItem, listItemMaster, updateItem } from "../src/server/services/itemService.js";
import { addItem, createOrder, sendKot } from "../src/server/services/orderService.js";
import { previewBill } from "../src/server/services/billingService.js";
import { getTableByCode, openTable } from "../src/server/services/tableService.js";
import { createTestApp } from "./helpers.js";

describe("item master", () => {
  it("creates, edits, prices by department, and deletes an item", () => {
    const { ctx } = createTestApp();
    const cashier = ctx("cashier");
    const created = createItem(cashier, {
      name: "STRAWBERRY UBE CLOUD",
      sku: "1207",
      salesGroup: "LIQUOR",
      itemGroup: "BEVERAGE",
      costPrice: 349,
      veg: false,
      stockItem: "No",
      allowComplimentary: true,
      rates: [
        { dept: "BAR", rate: 450, hsn: "2208", discount: true, enabled: true },
        { dept: "RESTAURANT", rate: 500, enabled: true },
        { dept: "NC", rate: 450, enabled: false },
      ],
    });
    expect(created.sku).toBe("1207");
    expect(created.name).toBe("STRAWBERRY UBE CLOUD");
    expect(created.costPrice).toBe(rupeesToPaise(349));
    expect(created.veg).toBe(false);
    expect(created.allowComplimentary).toBe(true);
    expect(created.rates.find((r) => r.dept === "BAR")?.rate).toBe(rupeesToPaise(450));
    expect(created.rates.find((r) => r.dept === "CAFE")?.enabled).toBe(true);
    expect(created.rates.find((r) => r.dept === "NC")?.enabled).toBe(false);
    expect(listItemMaster(cashier).nextCode).toBe("1208");

    const edited = updateItem(cashier, created.id, {
      name: "MANGO UBE CLOUD",
      sku: "1207",
      costPrice: 360,
      salesGroup: "LIQUOR",
      rates: [{ dept: "BAR", rate: 480, enabled: true }, { dept: "NC", rate: 480, enabled: false }],
    });
    expect(edited.name).toBe("MANGO UBE CLOUD");
    expect(edited.costPrice).toBe(rupeesToPaise(360));
    expect(edited.rates.find((r) => r.dept === "BAR")?.rate).toBe(rupeesToPaise(480));

    const waiter = ctx("waiter");
    const table = getTableByCode(waiter, "02");
    openTable(waiter, { tableId: table.id, outlet: "BAR" });
    const order = createOrder(waiter, table.id) as { id: string };
    const line = addItem(waiter, { orderId: order.id, productId: created.id, qty: 1 }) as {
      unit_price: number;
      name: string;
    };
    expect(line.name).toBe("MANGO UBE CLOUD");
    expect(line.unit_price).toBe(rupeesToPaise(480));

    const nc = getTableByCode(waiter, "03");
    openTable(waiter, { tableId: nc.id, outlet: "NC" });
    const ncOrder = createOrder(waiter, nc.id) as { id: string };
    expect(() => addItem(waiter, { orderId: ncOrder.id, productId: created.id, qty: 1 })).toThrow(/not sold/);

    deleteItem(cashier, created.id);
    expect(listItemMaster(cashier).items.some((i) => i.id === created.id)).toBe(false);
  });

  it("adds the sales-group tax on the bill and on the printed KOT", async () => {
    const { ctx, hardware } = createTestApp();
    const cashier = ctx("cashier");
    const master = listItemMaster(cashier);
    expect(master.salesGroups.slice(0, 6)).toEqual([
      "FOOD @ 18% - FOOD@ 18%",
      "GST FREE - GST TAX FREE",
      "ROOM GST 18% - GST TAX 18%",
      "S.C. VOLUNTARY @ 10% - S.C. VOLUNTARY",
      "VAT @ 24% - VAT@24%",
      "VAT TAX FREE - VAT@24%",
    ]);
    expect(master.itemGroups).toEqual(["BAR", "BEVERAGE", "EV CAFE", "EV FOOD", "FOOD", "SPL", "SPL1"]);

    const food = createItem(cashier, {
      name: "DAL FRY",
      sku: "2101",
      salesGroup: "FOOD @ 18% - FOOD@ 18%",
      itemGroup: "FOOD",
      rates: [{ dept: "RESTAURANT", rate: 100, enabled: true }],
    });
    const free = createItem(cashier, {
      name: "WATER",
      sku: "2102",
      salesGroup: "GST FREE - GST TAX FREE",
      itemGroup: "FOOD",
      rates: [{ dept: "RESTAURANT", rate: 20, enabled: true }],
    });

    const waiter = ctx("waiter");
    const table = getTableByCode(waiter, "06");
    openTable(waiter, { tableId: table.id, outlet: "RESTAURANT" });
    const order = createOrder(waiter, table.id) as { id: string };
    addItem(waiter, { orderId: order.id, productId: food.id, qty: 1 });
    addItem(waiter, { orderId: order.id, productId: free.id, qty: 2 });
    const bill = previewBill(cashier, order.id);
    const dal = bill.items.find((i) => i.name === "DAL FRY");
    const water = bill.items.find((i) => i.name === "WATER");
    expect(dal?.tax_rate).toBe(18);
    expect(dal?.tax).toBe(rupeesToPaise(18));
    expect(water?.tax_rate).toBe(0);
    expect(water?.tax).toBe(0);
    expect(bill.tax).toBe(rupeesToPaise(18));

    await sendKot(waiter, order.id);
    const printed = (hardware.kitchen as { logs: Array<{ payload: { items: Array<{ name: string; price?: number }> } }> }).logs.at(-1);
    const kotDal = printed?.payload.items.find((i) => i.name === "DAL FRY");
    const kotWater = printed?.payload.items.find((i) => i.name === "WATER");
    expect(kotDal?.price).toBe(rupeesToPaise(118));
    expect(kotWater?.price).toBe(rupeesToPaise(20));
  });
});
