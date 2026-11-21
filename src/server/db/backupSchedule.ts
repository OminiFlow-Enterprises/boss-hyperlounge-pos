import { startDatabaseWorker } from "./backgroundWorker.js";

const INTERVAL_MS = 30 * 60 * 1000;

export function scheduleBackups(filename: string) {
  const entry = new URL(import.meta.url.endsWith(".ts") ? "./backupWorker.ts" : "./backupWorker.js", import.meta.url);
  let running = false;
  function backup() {
    if (running) return;
    try {
      const worker = startDatabaseWorker(entry, { filename });
      running = true;
      worker.on("error", (error) => console.error("SQLite backup failed:", error.message));
      worker.once("exit", (code) => {
        running = false;
        if (code) console.error(`SQLite backup worker exited with code ${code}`);
      });
      worker.unref();
    } catch (error) {
      console.error("Unable to start SQLite backup:", error);
    }
  }
  const initial = setTimeout(backup, 15_000);
  const interval = setInterval(backup, INTERVAL_MS);
  initial.unref();
  interval.unref();
}
