import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const q = (process.argv[2] || "tikka wrap").toUpperCase();
const paths = [
  "C:/Users/pc/AppData/Roaming/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  "C:/Users/pc/Documents/GitHub/boss-hyperlounge-pos/data/hyperlounge.sqlite",
];

for (const p of paths) {
  const db = new Database(p, { readonly: true });
  const rows = db
    .prepare(
      `SELECT sku, name, active, sales_group, item_group, station, base_price, tax_rate
         FROM products
        WHERE upper(name) LIKE ?
        ORDER BY active DESC, name
        LIMIT 40`,
    )
    .all(`%${q}%`);
  const wrap = db
    .prepare(
      `SELECT sku, name, active, sales_group, item_group, station
         FROM products
        WHERE upper(name) LIKE '%WRAP%'
        ORDER BY active DESC, name
        LIMIT 40`,
    )
    .all();
  const chicken = db
    .prepare(
      `SELECT sku, name, active, item_group
         FROM products
        WHERE upper(name) LIKE '%CHICKEN TIKKA%'
        ORDER BY active DESC, name
        LIMIT 40`,
    )
    .all();
  console.log("---", p);
  console.log("match", JSON.stringify(rows, null, 2));
  console.log("wraps", JSON.stringify(wrap, null, 2));
  console.log("chicken tikka", JSON.stringify(chicken, null, 2));
  db.close();
}
