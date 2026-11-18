import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(
  "C:/Users/pc/AppData/Roaming/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  { readonly: true },
);
console.log(
  "settings",
  db.prepare("SELECT key, value FROM settings WHERE key LIKE 'service%'").all(),
);
const inv = db
  .prepare(
    `SELECT invoice_number, service_charge, service_charge_pct, discount, tax, grand_total, created_at
       FROM invoices ORDER BY created_at DESC LIMIT 10`,
  )
  .all()
  .map((r) => ({
    no: r.invoice_number,
    sc_pct: r.service_charge_pct,
    sc: (r.service_charge / 100).toFixed(2),
    disc: (r.discount / 100).toFixed(2),
    tax: (r.tax / 100).toFixed(2),
    gt: (r.grand_total / 100).toFixed(2),
    at: r.created_at,
  }));
console.log("recent invoices", inv);
db.close();
