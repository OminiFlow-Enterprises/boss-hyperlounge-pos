import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error("Usage: compare-catalog-dbs.mjs <db1> <db2> ...");
  process.exit(1);
}

function snap(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const active = db.prepare("SELECT COUNT(*) AS c FROM products WHERE active = 1").get().c;
  const seed = db
    .prepare(
      `SELECT sku, name, active FROM products
        WHERE sku GLOB 'BAR-*' OR sku GLOB 'FOOD-*'
        ORDER BY sku`,
    )
    .all();
  const freeBad = db
    .prepare(
      `SELECT COUNT(*) AS c FROM products
        WHERE active = 1 AND upper(COALESCE(sales_group,'')) LIKE '%FREE%' AND tax_rate != 0`,
    )
    .get().c;
  const groups = db
    .prepare(
      `SELECT sales_group, tax_rate, COUNT(*) AS c
         FROM products WHERE active = 1
         GROUP BY sales_group, tax_rate ORDER BY c DESC`,
    )
    .all();
  const skus = new Set(
    db.prepare("SELECT sku FROM products WHERE active = 1").all().map((r) => r.sku),
  );
  db.close();
  return { dbPath, active, seed, freeBad, groups, skus };
}

const snaps = paths.map(snap);
for (const s of snaps) {
  console.log("---");
  console.log(JSON.stringify({
    dbPath: s.dbPath,
    active: s.active,
    seedActive: s.seed.filter((x) => x.active).map((x) => x.sku),
    seedInactive: s.seed.filter((x) => !x.active).length,
    freeBad: s.freeBad,
    groups: s.groups,
  }, null, 2));
}

if (snaps.length >= 2) {
  const [a, b] = snaps;
  const onlyA = [...a.skus].filter((x) => !b.skus.has(x)).sort();
  const onlyB = [...b.skus].filter((x) => !a.skus.has(x)).sort();
  console.log("--- diff");
  console.log(JSON.stringify({
    onlyInFirst: onlyA.slice(0, 50),
    onlyInFirstCount: onlyA.length,
    onlyInSecond: onlyB.slice(0, 50),
    onlyInSecondCount: onlyB.length,
  }, null, 2));
}
