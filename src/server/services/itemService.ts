import { AppError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { uuid } from "../lib/ids.js";
import { rupeesToPaise } from "../../shared/money.js";

import { USER_OUTLETS } from "../../shared/userRights.js";

export const ITEM_DEPTS = USER_OUTLETS;

export const SALES_GROUPS: Array<{ name: string; tax: number }> = [
  { name: "FOOD @ 18% - FOOD@ 18%", tax: 18 },
  { name: "GST FREE - GST TAX FREE", tax: 0 },
  { name: "ROOM GST 18% - GST TAX 18%", tax: 18 },
  { name: "S.C. VOLUNTARY @ 10% - S.C. VOLUNTARY", tax: 10 },
  { name: "VAT @ 24% - VAT@24%", tax: 24 },
  { name: "VAT TAX FREE - VAT@24%", tax: 0 },
];

export const ITEM_GROUPS = ["BAR", "BEVERAGE", "EV CAFE", "EV FOOD", "FOOD", "SPL", "SPL1"];

/** Item groups listed on each billing tab. NC shows every group. */
export const TAB_ITEM_GROUPS: Record<string, string[] | null> = {
  BAR: ["BAR", "BEVERAGE"],
  RESTAURANT: ["FOOD"],
  "THE BOSS CLUB": ["EV CAFE", "EV FOOD", "SPL", "SPL1"],
  NC: null,
};

type RateInput = {
  dept?: string;
  rate?: number;
  hsn?: string;
  inclusive?: boolean;
  discount?: boolean;
  enabled?: boolean;
};

export type ItemSaveInput = {
  name?: string;
  sku?: string;
  salesGroup?: string;
  itemGroup?: string;
  costPrice?: number;
  veg?: boolean;
  stockItem?: string;
  allowComplimentary?: boolean;
  hideInWeb?: boolean;
  nameHindi?: string;
  mixItem?: boolean;
  logo?: string;
  rates?: RateInput[];
};

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  cost_price: number;
  sales_group: string;
  item_group: string;
  is_veg: number;
  stock_item: string;
  allow_complimentary: number;
  hide_in_web: number;
  name_hindi: string;
  mix_item: number;
  logo: string;
  base_price: number;
  station: string;
  tax_rate: number;
  category_id: string;
  track_inventory: number;
};

function ensureGroups(ctx: AppContext) {
  const insSales = ctx.db.prepare("INSERT INTO sales_groups (id, name) VALUES (?, ?)");
  const hasSales = ctx.db.prepare("SELECT id FROM sales_groups WHERE UPPER(name) = UPPER(?)");
  for (const group of SALES_GROUPS) {
    if (!hasSales.get(group.name)) insSales.run(uuid(), group.name);
  }
  const insItem = ctx.db.prepare("INSERT INTO item_groups (id, name) VALUES (?, ?)");
  const hasItem = ctx.db.prepare("SELECT id FROM item_groups WHERE UPPER(name) = UPPER(?)");
  for (const name of ITEM_GROUPS) {
    if (!hasItem.get(name)) insItem.run(uuid(), name);
  }
  const salesUsed = ctx.db.prepare("SELECT COUNT(*) AS n FROM products WHERE UPPER(sales_group) = UPPER(?)");
  const salesRows = ctx.db.prepare("SELECT id, name FROM sales_groups").all() as Array<{ id: string; name: string }>;
  const keepSales = new Set(SALES_GROUPS.map((g) => g.name.toUpperCase()));
  for (const row of salesRows) {
    if (keepSales.has(row.name.toUpperCase())) continue;
    const used = salesUsed.get(row.name) as { n: number };
    if (used.n === 0) ctx.db.prepare("DELETE FROM sales_groups WHERE id = ?").run(row.id);
  }
  const itemUsed = ctx.db.prepare("SELECT COUNT(*) AS n FROM products WHERE UPPER(item_group) = UPPER(?)");
  const itemRows = ctx.db.prepare("SELECT id, name FROM item_groups").all() as Array<{ id: string; name: string }>;
  const keepItems = new Set(ITEM_GROUPS.map((name) => name.toUpperCase()));
  for (const row of itemRows) {
    if (keepItems.has(row.name.toUpperCase())) continue;
    const used = itemUsed.get(row.name) as { n: number };
    if (used.n === 0) ctx.db.prepare("DELETE FROM item_groups WHERE id = ?").run(row.id);
  }
}

export function taxForSalesGroup(name: string): number | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const known = SALES_GROUPS.find((g) => g.name.toUpperCase() === trimmed.toUpperCase());
  if (known) return known.tax;
  const upper = trimmed.toUpperCase();
  if (upper.includes("TAX FREE") || upper.includes("GST FREE")) return 0;
  const match = upper.match(/(\d+(?:\.\d+)?)\s*%/);
  if (match) return Number(match[1]);
  return null;
}

/** Tax % to show on bill / KOT: sales group first; if product has no group, same-name catalog row with a group. Does not write the DB. */
export function displayTaxRate(
  ctx: AppContext,
  input: {
    name: string;
    salesGroup?: string | null;
    productTaxRate?: number | null;
    lineTaxRate?: number | null;
  },
): number {
  const fromGroup = taxForSalesGroup(input.salesGroup ?? "");
  if (fromGroup != null) return fromGroup;
  if (!String(input.salesGroup ?? "").trim()) {
    const alt = ctx.db
      .prepare(
        `SELECT sales_group, tax_rate FROM products
          WHERE active = 1 AND UPPER(name) = UPPER(?) AND IFNULL(sales_group, '') != ''
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(input.name) as { sales_group: string; tax_rate: number } | undefined;
    if (alt) {
      const altGroup = taxForSalesGroup(alt.sales_group);
      if (altGroup != null) return altGroup;
      const altTax = Number(alt.tax_rate);
      if (Number.isFinite(altTax)) return altTax;
    }
  }
  const productTax = Number(input.productTaxRate);
  if (Number.isFinite(productTax)) return productTax;
  const lineTax = Number(input.lineTaxRate);
  return Number.isFinite(lineTax) ? lineTax : 0;
}

function orderedNames(rows: string[], canonical: string[]) {
  const out: string[] = [];
  for (const name of canonical) {
    const found = rows.find((row) => row.toUpperCase() === name.toUpperCase());
    if (found) out.push(found);
  }
  for (const row of rows) {
    if (!out.some((name) => name.toUpperCase() === row.toUpperCase())) out.push(row);
  }
  return out;
}

export function nextItemCode(ctx: AppContext): string {
  const row = ctx.db
    .prepare("SELECT MAX(CAST(sku AS INTEGER)) AS n FROM products WHERE sku GLOB '[0-9]*'")
    .get() as { n: number | null };
  const n = row.n && row.n >= 1000 ? row.n + 1 : 1001;
  return String(n);
}

function ratesFor(ctx: AppContext, productId: string, basePrice: number) {
  const rows = ctx.db
    .prepare("SELECT dept, rate, hsn, inclusive, discount, enabled FROM product_dept_rates WHERE product_id = ?")
    .all(productId) as Array<{
    dept: string;
    rate: number;
    hsn: string;
    inclusive: number;
    discount: number;
    enabled: number;
  }>;
  const byDept = new Map(rows.map((r) => [r.dept, r]));
  const configured = rows.length > 0;
  return ITEM_DEPTS.map((dept) => {
    const r = byDept.get(dept);
    if (!r) {
      return {
        dept,
        rate: configured ? 0 : basePrice,
        hsn: "",
        inclusive: false,
        discount: true,
        enabled: true,
      };
    }
    return {
      dept,
      rate: r.rate,
      hsn: r.hsn ?? "",
      inclusive: r.inclusive !== 0,
      discount: r.discount !== 0,
      enabled: r.enabled !== 0,
    };
  });
}

function present(ctx: AppContext, row: ProductRow) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    costPrice: row.cost_price,
    salesGroup: row.sales_group ?? "",
    itemGroup: row.item_group ?? "",
    veg: row.is_veg !== 0,
    stockItem: row.stock_item ?? "",
    allowComplimentary: row.allow_complimentary !== 0,
    hideInWeb: row.hide_in_web !== 0,
    nameHindi: row.name_hindi ?? "",
    mixItem: row.mix_item !== 0,
    logo: row.logo ?? "",
    basePrice: row.base_price,
    rates: ratesFor(ctx, row.id, row.base_price),
  };
}

function listRows(ctx: AppContext) {
  return ctx.db
    .prepare(
      `SELECT id, sku, name, cost_price, sales_group, item_group, is_veg, stock_item,
              allow_complimentary, hide_in_web, name_hindi, mix_item, logo, base_price,
              station, tax_rate, category_id, track_inventory
         FROM products
        WHERE active = 1
        ORDER BY CASE WHEN sku GLOB '[0-9]*' THEN 0 ELSE 1 END,
                 CAST(sku AS INTEGER) DESC,
                 name COLLATE NOCASE`,
    )
    .all() as ProductRow[];
}

export function listItemMaster(ctx: AppContext) {
  ensureGroups(ctx);
  const salesGroups = orderedNames(
    (ctx.db.prepare("SELECT name FROM sales_groups").all() as Array<{ name: string }>).map((r) => r.name),
    SALES_GROUPS.map((g) => g.name),
  );
  const itemGroups = orderedNames(
    (ctx.db.prepare("SELECT name FROM item_groups").all() as Array<{ name: string }>).map((r) => r.name),
    ITEM_GROUPS,
  );
  return {
    items: listRows(ctx).map((row) => present(ctx, row)),
    salesGroups,
    itemGroups,
    nextCode: nextItemCode(ctx),
  };
}

export function deptRatesByProduct(ctx: AppContext) {
  const rows = ctx.db
    .prepare("SELECT product_id, dept, rate, enabled, inclusive FROM product_dept_rates")
    .all() as Array<{
    product_id: string;
    dept: string;
    rate: number;
    enabled: number;
    inclusive: number;
  }>;
  const map: Record<string, Record<string, { rate: number; enabled: number; inclusive: number }>> = {};
  for (const r of rows) {
    (map[r.product_id] ??= {})[r.dept] = {
      rate: r.rate,
      enabled: r.enabled,
      inclusive: r.inclusive ? 1 : 0,
    };
  }
  return map;
}

function paiseAmount(value: unknown, label: string) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new AppError(`Invalid ${label}`);
  return rupeesToPaise(n);
}

function stationFor(
  salesGroup: string,
  itemGroup: string,
  existing?: { station: string; tax_rate: number },
) {
  const group = itemGroup.trim().toUpperCase();
  const sales = salesGroup.trim().toUpperCase();
  let station = existing?.station ?? "KITCHEN";
  if (group === "BAR" || group === "BEVERAGE") station = "BAR";
  else if (group === "FOOD" || group === "EV FOOD" || group === "EV CAFE" || group === "SPL" || group === "SPL1") station = "KITCHEN";
  else if (sales.includes("VAT") && !sales.includes("FREE")) station = "BAR";
  const fromGroup = taxForSalesGroup(salesGroup);
  const tax = fromGroup == null ? (existing?.tax_rate ?? (station === "BAR" ? 18 : 5)) : fromGroup;
  return { station, tax };
}

function categoryFor(ctx: AppContext, station: string) {
  const row = ctx.db.prepare("SELECT id FROM categories WHERE station = ? LIMIT 1").get(station) as
    | { id: string }
    | undefined;
  if (row) return row.id;
  const id = uuid();
  ctx.db
    .prepare("INSERT INTO categories (id, name, station) VALUES (?, ?, ?)")
    .run(id, station === "BAR" ? "Drinks" : "Food", station);
  return id;
}

function normalizedRates(input: RateInput[] | undefined) {
  const byDept = new Map((input ?? []).map((r) => [String(r.dept ?? ""), r]));
  return ITEM_DEPTS.map((dept) => {
    const r = byDept.get(dept);
    return {
      dept,
      rate: paiseAmount(r?.rate ?? 0, "rate"),
      hsn: String(r?.hsn ?? "").trim().slice(0, 20),
      inclusive: r?.inclusive ? 1 : 0,
      discount: r?.discount === false ? 0 : 1,
      enabled: r?.enabled === false ? 0 : 1,
    };
  });
}

function sellingPrice(rates: Array<{ dept: string; rate: number; enabled: number }>) {
  const bar = rates.find((r) => r.dept === "BAR" && r.enabled && r.rate > 0);
  if (bar) return bar.rate;
  const any = rates.find((r) => r.enabled && r.rate > 0);
  return any?.rate ?? 0;
}

function rememberGroup(ctx: AppContext, table: "sales_groups" | "item_groups", name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const existing = ctx.db.prepare(`SELECT id FROM ${table} WHERE UPPER(name) = UPPER(?)`).get(trimmed);
  if (existing) return;
  ctx.db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`).run(uuid(), trimmed);
}

export function addItemGroup(ctx: AppContext, name: string) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new AppError("Enter item group");
  if (trimmed.length > 40) throw new AppError("Item group is too long");
  const existing = ctx.db.prepare("SELECT name FROM item_groups WHERE UPPER(name) = UPPER(?)").get(trimmed) as
    | { name: string }
    | undefined;
  if (existing) return { name: existing.name, itemGroups: listItemMaster(ctx).itemGroups };
  ctx.db.prepare("INSERT INTO item_groups (id, name) VALUES (?, ?)").run(uuid(), trimmed);
  return { name: trimmed, itemGroups: listItemMaster(ctx).itemGroups };
}

function writeItem(ctx: AppContext, id: string | null, input: ItemSaveInput) {
  const name = String(input.name ?? "").trim();
  const sku = String(input.sku ?? "").trim();
  if (!name) throw new AppError("Enter Item Name");
  if (!sku) throw new AppError("Enter Item Code");
  if (name.length > 80) throw new AppError("Item name is too long");
  if (sku.length > 32) throw new AppError("Item code is too long");
  const logo = String(input.logo ?? "");
  if (logo.length > 200_000) throw new AppError("Logo too large");
  const dup = ctx.db.prepare("SELECT id FROM products WHERE UPPER(sku) = UPPER(?) AND id != ?").get(sku, id ?? "") as
    | { id: string }
    | undefined;
  if (dup) throw new AppError("Item code already exists");

  const existing = id
    ? (ctx.db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(id) as ProductRow | undefined)
    : undefined;
  if (id && !existing) throw new AppError("Item not found", 404);

  const salesGroup = String(input.salesGroup ?? "").trim();
  const itemGroup = String(input.itemGroup ?? "").trim();
  const stockItem = String(input.stockItem ?? "").trim();
  const rates = normalizedRates(input.rates);
  const base = sellingPrice(rates);
  const placed = stationFor(
    salesGroup,
    itemGroup,
    existing ? { station: existing.station, tax_rate: existing.tax_rate } : undefined,
  );
  const track =
    stockItem === "Yes" ? 1 : stockItem === "No" ? 0 : existing ? existing.track_inventory : 0;
  const categoryId = existing?.category_id ?? categoryFor(ctx, placed.station);

  const fields = {
    sku,
    name,
    salesGroup,
    itemGroup,
    cost: paiseAmount(input.costPrice ?? 0, "cost price"),
    veg: input.veg === false ? 0 : 1,
    stockItem: stockItem === "Yes" || stockItem === "No" ? stockItem : "",
    comp: input.allowComplimentary ? 1 : 0,
    hide: input.hideInWeb ? 1 : 0,
    hindi: String(input.nameHindi ?? "").trim().slice(0, 80),
    mix: input.mixItem ? 1 : 0,
    logo,
    base,
    station: placed.station,
    tax: placed.tax,
    track,
    categoryId,
  };

  const save = ctx.db.transaction(() => {
    rememberGroup(ctx, "sales_groups", salesGroup);
    rememberGroup(ctx, "item_groups", itemGroup);
    const itemId = id ?? uuid();
    if (existing) {
      ctx.db
        .prepare(
          `UPDATE products SET
             sku = ?, name = ?, category_id = ?, station = ?, base_price = ?, tax_rate = ?,
             track_inventory = ?, sales_group = ?, item_group = ?, cost_price = ?, is_veg = ?,
             stock_item = ?, allow_complimentary = ?, hide_in_web = ?, name_hindi = ?, mix_item = ?, logo = ?
           WHERE id = ?`,
        )
        .run(
          fields.sku,
          fields.name,
          fields.categoryId,
          fields.station,
          fields.base,
          fields.tax,
          fields.track,
          fields.salesGroup,
          fields.itemGroup,
          fields.cost,
          fields.veg,
          fields.stockItem,
          fields.comp,
          fields.hide,
          fields.hindi,
          fields.mix,
          fields.logo,
          itemId,
        );
    } else {
      ctx.db
        .prepare(
          `INSERT INTO products
            (id, sku, name, category_id, station, base_price, tax_rate, track_inventory, unit, active,
             sales_group, item_group, cost_price, is_veg, stock_item, allow_complimentary, hide_in_web,
             name_hindi, mix_item, logo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pc', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          itemId,
          fields.sku,
          fields.name,
          fields.categoryId,
          fields.station,
          fields.base,
          fields.tax,
          fields.track,
          fields.salesGroup,
          fields.itemGroup,
          fields.cost,
          fields.veg,
          fields.stockItem,
          fields.comp,
          fields.hide,
          fields.hindi,
          fields.mix,
          fields.logo,
        );
      ctx.db.prepare("INSERT INTO inventory (product_id, quantity, reserved) VALUES (?, 0, 0)").run(itemId);
    }
    const up = ctx.db.prepare(
      `INSERT INTO product_dept_rates (product_id, dept, rate, hsn, inclusive, discount, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_id, dept) DO UPDATE SET
         rate = excluded.rate, hsn = excluded.hsn, inclusive = excluded.inclusive,
         discount = excluded.discount, enabled = excluded.enabled`,
    );
    for (const r of rates) up.run(itemId, r.dept, r.rate, r.hsn, r.inclusive, r.discount, r.enabled);
    return itemId;
  });

  const itemId = save();
  audit(ctx, id ? "ITEM_UPDATE" : "ITEM_CREATE", "product", itemId, null, existing ? { sku: existing.sku, name: existing.name } : null, {
    sku,
    name,
  });
  const row = ctx.db.prepare("SELECT * FROM products WHERE id = ?").get(itemId) as ProductRow;
  return present(ctx, row);
}

export function createItem(ctx: AppContext, input: ItemSaveInput) {
  return writeItem(ctx, null, input);
}

export function updateItem(ctx: AppContext, id: string, input: ItemSaveInput) {
  return writeItem(ctx, id, input);
}

export function deleteItem(ctx: AppContext, id: string) {
  const row = ctx.db.prepare("SELECT id, sku, name FROM products WHERE id = ? AND active = 1").get(id) as
    | { id: string; sku: string; name: string }
    | undefined;
  if (!row) throw new AppError("Item not found", 404);
  ctx.db.prepare("UPDATE products SET active = 0 WHERE id = ?").run(id);
  audit(ctx, "ITEM_DELETE", "product", id, null, { sku: row.sku, name: row.name }, null);
  return { ok: true };
}
