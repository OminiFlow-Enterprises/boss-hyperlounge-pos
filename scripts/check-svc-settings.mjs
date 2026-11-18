import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const paths = [
  "C:/Users/pc/AppData/Roaming/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  "C:/Users/pc/Documents/GitHub/boss-hyperlounge-pos/data/hyperlounge.sqlite",
];
for (const p of paths) {
  const db = new Database(p, { readonly: true });
  const settings = db.prepare(
    "SELECT key, value FROM settings WHERE key LIKE '%service%' OR key LIKE '%charge%' OR key LIKE '%surcharge%'",
  ).all();
  console.log(p, JSON.stringify(settings));
  db.close();
}
