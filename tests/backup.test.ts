import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { startDatabaseWorker } from "../src/server/db/backgroundWorker.js";

const workerEntry = new URL("../src/server/db/backupWorker.ts", import.meta.url);
const previousName = "pos-2020-01-01T10-00-00-000Z-5b2a6360-60e6-43db-ba71-c50eac06a658.sqlite";

function runBackup(filename: string) {
  return new Promise<void>((resolve, reject) => {
    const worker = startDatabaseWorker(workerEntry, { filename });
    worker.once("error", reject);
    worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Backup worker exited with code ${code}`)));
  });
}

it("keeps one verified daily backup and retains the previous one if replacement fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boss-backup-test-"));
  try {
    const backupDir = path.join(root, "backups");
    const dataDir = path.join(root, "data");
    const sourcePath = path.join(dataDir, "pos.sqlite");
    await mkdir(dataDir);
    await mkdir(backupDir);
    const previousPath = path.join(backupDir, previousName);
    const previous = new Database(previousPath);
    previous.exec("CREATE TABLE sales (id INTEGER PRIMARY KEY);");
    previous.close();
    const yesterday = new Date(2020, 0, 1);
    await utimes(previousPath, yesterday, yesterday);
    await writeFile(path.join(backupDir, "manual.sqlite"), "manual");

    await expect(runBackup(sourcePath)).rejects.toThrow();
    expect(await readdir(backupDir)).toEqual(expect.arrayContaining([previousName, "manual.sqlite"]));

    const source = new Database(sourcePath);
    source.pragma("journal_mode = WAL");
    source.exec("CREATE TABLE sales (id INTEGER PRIMARY KEY); INSERT INTO sales VALUES (42);");
    try {
      await runBackup(sourcePath);
      const entries = await readdir(backupDir);
      expect(entries).toHaveLength(2);
      expect(entries).toContain("manual.sqlite");
      expect(entries).not.toContain(previousName);
      const latest = entries.find((name) => name.startsWith("pos-"))!;
      const verified = new Database(path.join(backupDir, latest), { readonly: true });
      try {
        expect(verified.pragma("quick_check", { simple: true })).toBe("ok");
        expect(verified.prepare("SELECT id FROM sales").get()).toEqual({ id: 42 });
      } finally {
        verified.close();
      }

      await runBackup(sourcePath);
      expect(await readdir(backupDir)).toEqual(entries);
    } finally {
      source.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
