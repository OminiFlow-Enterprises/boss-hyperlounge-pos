/**
 * Remove demo seed SKUs (BAR- and FOOD- prefixes) that were extra-added on top
 * of the imported THE BOSS catalog, and sync products.tax_rate from sales_group.
 *
 * Usage (Electron ABI): electron scripts/fix-catalog-from-import.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.POS_DATA_DIR
  ? path.join(process.env.POS_DATA_DIR, "hyperlounge.sqlite")
  : path.join(root, "data", "hyperlounge.sqlite");

function taxFromSalesGroup(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (upper.includes("TAX FREE") || upper.includes("GST FREE") || upper.includes("FREE")) return 0;
  const match = upper.match(/(\d+(?:\.\d+)?)\s*%/);
  if (match) return Number(match[1]);
  return null;
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const seedSkus = db
  .prepare(
    `SELECT id, sku, name, active FROM products
      WHERE sku GLOB 'BAR-*' OR sku GLOB 'FOOD-*'
      ORDER BY sku`,
  )
  .all();

const deactivate = db.prepare("UPDATE products SET active = 0 WHERE id = ?");
let deactivated = 0;
const tx = db.transaction(() => {
  for (const row of seedSkus) {
    if (row.active) {
      deactivate.run(row.id);
      deactivated += 1;
    }
  }
});
tx();

const products = db.prepare("SELECT id, name, sales_group, tax_rate, active FROM products").all();
const upd = db.prepare("UPDATE products SET tax_rate = ? WHERE id = ?");
let taxFixed = 0;
const taxTx = db.transaction(() => {
  for (const p of products) {
    const expected = taxFromSalesGroup(p.sales_group);
    if (expected == null) continue;
    if (Number(p.tax_rate) === expected) continue;
    upd.run(expected, p.id);
    taxFixed += 1;
  }
});
taxTx();

const beerLeft = db
  .prepare(
    `SELECT sku, name, sales_group, tax_rate, active FROM products
      WHERE upper(name) = 'BEER' OR sku = 'BAR-BE'
      ORDER BY sku`,
  )
  .all();
const activeSeed = db
  .prepare(
    `SELECT COUNT(*) AS c FROM products WHERE active = 1 AND (sku GLOB 'BAR-*' OR sku GLOB 'FOOD-*')`,
  )
  .get().c;
const freeBad = db
  .prepare(
    `SELECT COUNT(*) AS c FROM products
      WHERE active = 1 AND upper(sales_group) LIKE '%FREE%' AND tax_rate != 0`,
  )
  .get().c;

console.log(JSON.stringify({
  dbPath,
  seedRowsFound: seedSkus.length,
  deactivated,
  taxFixed,
  activeSeedLeft: activeSeed,
  freeGroupStillTaxed: freeBad,
  beerRows: beerLeft,
}, null, 2));

db.close();
