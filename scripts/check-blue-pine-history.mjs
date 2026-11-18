import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(
  "C:/Users/pc/AppData/Roaming/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  { readonly: true },
);

const p = db.prepare(`SELECT id FROM products WHERE sku = '455'`).get();
const hist = db
  .prepare(
    `SELECT oi.unit_price, oi.tax_rate, oi.qty, oi.name, o.created_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = ? OR upper(oi.name) LIKE '%BLUE PINE 750%'
      ORDER BY o.created_at DESC
      LIMIT 15`,
  )
  .all(p.id);
console.log(
  "orders",
  hist.map((h) => ({ name: h.name, qty: h.qty, unit_rs: (h.unit_price / 100).toFixed(2), tax: h.tax_rate, at: h.created_at })),
);

const inc = db.prepare(`SELECT COUNT(*) c FROM product_dept_rates WHERE inclusive = 1`).get().c;
const incOn = db
  .prepare(
    `SELECT COUNT(*) c FROM product_dept_rates WHERE inclusive = 1 AND enabled = 1`,
  )
  .get().c;
const sample = db
  .prepare(
    `SELECT p.sku, p.name, p.tax_rate, p.sales_group, r.dept, r.rate, r.inclusive
       FROM product_dept_rates r
       JOIN products p ON p.id = r.product_id
      WHERE r.inclusive = 1 AND r.enabled = 1 AND r.dept = 'BAR'
      ORDER BY p.name LIMIT 15`,
  )
  .all();
console.log({ inclusiveRows: inc, inclusiveEnabled: incOn });
console.log(
  "sample inclusive BAR",
  sample.map((s) => ({
    sku: s.sku,
    name: s.name,
    tax: s.tax_rate,
    rate: (s.rate / 100).toFixed(2),
    excl: s.tax_rate > 0 ? (s.rate / (100 + s.tax_rate)).toFixed(2) : (s.rate / 100).toFixed(2),
  })),
);
db.close();
