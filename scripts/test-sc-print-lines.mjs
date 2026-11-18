import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(
  "C:/Users/pc/AppData/Roaming/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  { readonly: true },
);

const inv = db
  .prepare(
    `SELECT id, invoice_number, food_total, drinks_total, discount, service_charge, service_charge_pct, tax, other_charges, grand_total
       FROM invoices ORDER BY created_at DESC LIMIT 1`,
  )
  .get();

const items = db
  .prepare(
    `SELECT ii.amount, ii.name, p.sales_group, p.tax_rate AS product_tax_rate, oi.tax_rate AS line_tax_rate
       FROM invoice_items ii
       LEFT JOIN products p ON p.id = ii.product_id
       LEFT JOIN order_items oi ON oi.id = ii.order_item_id
      WHERE ii.invoice_id = ?`,
  )
  .all(inv.id);

const modPath = pathToFileURL(
  path.resolve("C:/Users/pc/Documents/GitHub/boss-hyperlounge-pos/dist/server/hardware/billTotals.js"),
).href;
const { buildBillTotalLines } = await import(modPath);

const subtotal = inv.food_total + inv.drinks_total;
const discountPct = subtotal > 0 ? Math.round((inv.discount / subtotal) * 10000) / 100 : 0;
const unrounded = subtotal - inv.discount + inv.service_charge + inv.tax + inv.other_charges;
const roundOff = inv.grand_total - unrounded;

const lines = buildBillTotalLines({
  lines: items.map((row) => ({
    amount: row.amount,
    taxRate: Number(row.product_tax_rate ?? row.line_tax_rate ?? 0),
    salesGroup: row.sales_group,
  })),
  discount: inv.discount,
  discountPct,
  serviceCharge: inv.service_charge,
  serviceChargePct: inv.service_charge_pct ?? 0,
  otherCharges: inv.other_charges,
  roundOff,
  taxTotal: inv.tax,
});

console.log(
  JSON.stringify(
    {
      invoice: inv.invoice_number,
      sc_pct: inv.service_charge_pct,
      sc: (inv.service_charge / 100).toFixed(2),
      gt: (inv.grand_total / 100).toFixed(2),
      printLines: lines.map((l) => ({
        label: l.label,
        base: l.base != null ? (l.base / 100).toFixed(2) : "",
        amt: (l.amount / 100).toFixed(2),
      })),
    },
    null,
    2,
  ),
);
db.close();
