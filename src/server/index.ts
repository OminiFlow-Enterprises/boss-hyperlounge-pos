import fs from "node:fs";
import { createApp } from "./api/app.js";
import { defaultDbPath, openDatabase } from "./db/database.js";
import { scheduleBackups } from "./db/backupSchedule.js";
import { seedIfEmpty } from "./db/seed.js";
import { createHardware } from "./hardware/index.js";
import { createKotPrintWorker } from "./services/kotPrintQueue.js";

const port = Number(process.env.PORT ?? 8787);
const filePath = defaultDbPath();
const firstRun = !fs.existsSync(filePath);
const existingOnly = process.env.POS_EXISTING_DB_ONLY === "1";
const db = openDatabase({ filePath, existingOnly });
if (firstRun) seedIfEmpty(db);
const hardware = createHardware();
const queuePrinting = !existingOnly || Boolean(db.prepare(
  "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'kot_print_jobs'",
).get());
const app = createApp({ db, hardware, online: process.env.OFFLINE !== "1", queuePrinting });

const listener = app.listen(port, "0.0.0.0", () => {
  console.log(`BOSS Hyperlounge POS on http://0.0.0.0:${port}`);
  scheduleBackups(db.name);
  if (!queuePrinting) return;
  const printQueuedKots = createKotPrintWorker(db, hardware);
  setInterval(() => {
    void printQueuedKots().catch((error) => console.error("KOT print queue:", error));
  }, 500).unref();
});
listener.on("error", (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
