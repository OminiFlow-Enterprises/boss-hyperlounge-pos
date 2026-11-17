import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(root, "data", "hyperlounge.sqlite");
const db = new Database(dbPath, { readonly: true });

const byGroup = db
  .prepare(
    `SELECT sales_group, COUNT(*) AS c, tax_rate
       FROM products WHERE active = 1
       GROUP BY sales_group, tax_rate
       ORDER BY c DESC`,
  )
  .all();
const active = db.prepare("SELECT COUNT(*) AS c FROM products WHERE active = 1").get().c;
const inactiveSeed = db
  .prepare(
    `SELECT COUNT(*) AS c FROM products
      WHERE active = 0 AND (sku GLOB 'BAR-*' OR sku GLOB 'FOOD-*')`,
  )
  .get().c;
const beer = db
  .prepare(
    `SELECT sku, name, sales_group, tax_rate, active FROM products
      WHERE upper(name) LIKE '%BEER%' OR upper(name) LIKE '%KINGFISHER%'
      ORDER BY active DESC, name LIMIT 30`,
  )
  .all();

console.log(JSON.stringify({ active, inactiveSeed, byGroup, beer }, null, 2));
db.close();
