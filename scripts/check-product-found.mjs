import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const paths = [
  "C:/Users/pc/AppData/Roaming/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  "C:/Users/pc/Documents/GitHub/boss-hyperlounge-pos/data/hyperlounge.sqlite",
];

for (const p of paths) {
  const db = new Database(p, { readonly: true });
  const active = db.prepare("SELECT COUNT(*) AS c FROM products WHERE active = 1").get().c;
  const listed = db
    .prepare(
      `SELECT COUNT(*) AS c FROM products p
        JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1`,
    )
    .get().c;
  const orphan = db
    .prepare(
      `SELECT COUNT(*) AS c FROM products p
        WHERE p.active = 1
          AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id)`,
    )
    .get().c;
  const seedInList = db
    .prepare(
      `SELECT sku, name, active FROM products
        WHERE sku GLOB 'BAR-*' OR sku GLOB 'FOOD-*'
        ORDER BY sku`,
    )
    .all();
  const sample = db
    .prepare(
      `SELECT id, sku, name, active, category_id FROM products
        WHERE active = 1 AND name LIKE '%KINGFISHER ULTRA PINT%' LIMIT 3`,
    )
    .all();
  console.log(JSON.stringify({ p, active, listed, orphan, seedInList, sample }, null, 2));
  db.close();
}
