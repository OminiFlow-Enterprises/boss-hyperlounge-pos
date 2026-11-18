import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(
  "C:/Users/pc/AppData/Roaming/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  { readonly: true },
);

const p = db
  .prepare(
    `SELECT id, sku, name, item_group, station, active, base_price
       FROM products WHERE upper(name) = 'CHICKEN TIKKA WRAP'`,
  )
  .get();
console.log("product", p);
const rates = db
  .prepare(
    `SELECT dept, rate, enabled, hsn FROM product_dept_rates WHERE product_id = ? ORDER BY dept`,
  )
  .all(p.id);
console.log("dept_rates", rates);

const inBootstrap = db
  .prepare(
    `SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.active = 1 AND p.sku = '65'`,
  )
  .get();
console.log("in listProducts join", !!inBootstrap);

db.close();
