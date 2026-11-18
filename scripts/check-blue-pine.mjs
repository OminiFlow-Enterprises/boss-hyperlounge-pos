import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const paths = [
  "C:/Users/pc/AppData/Roaming/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  "C:/Users/pc/Documents/GitHub/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  "C:/Users/pc/Documents/JSW/THE BOSS POS-1.0.0-win (1)/resources/data/hyperlounge.sqlite",
  "C:/Users/pc/Documents/JSW/THE BOSS POS-1.0.0-win (2)/resources/data/hyperlounge.sqlite",
];

function dump(dbPath) {
  if (!fs.existsSync(dbPath)) return { dbPath, missing: true };
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, sku, name, active, base_price, cost_price, sales_group, item_group, tax_rate
         FROM products
        WHERE upper(name) LIKE '%BLUE PINE%'
        ORDER BY active DESC, name`,
    )
    .all();
  const withRates = rows.map((r) => {
    const rates = db
      .prepare(
        `SELECT dept, rate, enabled FROM product_dept_rates WHERE product_id = ? ORDER BY dept`,
      )
      .all(r.id);
    return {
      ...r,
      base_rs: (r.base_price / 100).toFixed(2),
      cost_rs: r.cost_price != null ? (r.cost_price / 100).toFixed(2) : null,
      rates: rates.map((x) => ({
        dept: x.dept,
        rate_rs: (x.rate / 100).toFixed(2),
        enabled: x.enabled,
      })),
    };
  });
  db.close();
  return { dbPath, items: withRates };
}

for (const p of paths) {
  console.log(JSON.stringify(dump(p), null, 2));
  console.log("---");
}
