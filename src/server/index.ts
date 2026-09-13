import { createApp } from "./api/app.js";
import { openDatabase } from "./db/database.js";
import { seedIfEmpty } from "./db/seed.js";
import { createHardware } from "./hardware/index.js";

const port = Number(process.env.PORT ?? 8787);
const db = openDatabase();
seedIfEmpty(db);
const hardware = createHardware();
const app = createApp({ db, hardware, online: process.env.OFFLINE !== "1" });

app.listen(port, "0.0.0.0", () => {
  console.log(`BOSS Hyperlounge POS on http://0.0.0.0:${port}`);
});
