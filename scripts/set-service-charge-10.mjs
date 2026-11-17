import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const paths = [
  "C:/Users/pc/AppData/Roaming/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  "C:/Users/pc/Documents/GitHub/boss-hyperlounge-pos/data/hyperlounge.sqlite",
  "C:/Users/pc/Documents/JSW/THE BOSS POS-1.0.0-win (1)/resources/data/hyperlounge.sqlite",
  "C:/Users/pc/Documents/JSW/THE BOSS POS-1.0.0-win (2)/resources/data/hyperlounge.sqlite",
];

for (const p of paths) {
  try {
    const db = new Database(p);
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('service_charge_pct', '10')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('service_charge_mode', 'EXCLUSIVE')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'service_charge_pct'").get();
    console.log(p, "→", row?.value);
    db.close();
  } catch (e) {
    console.log(p, "skip", e instanceof Error ? e.message : e);
  }
}
