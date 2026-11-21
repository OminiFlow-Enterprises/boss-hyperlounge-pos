import { mkdir, open, readdir, rename, rm, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const { filename } = workerData.data as { filename: string };
const directory = path.join(path.dirname(path.dirname(path.resolve(filename))), "backups");
const backupName = `pos-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.sqlite`;
const temporary = path.join(directory, `${backupName}.partial`);
await mkdir(directory, { recursive: true });
try {
  const source = new Database(filename, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    const disk = await statfs(directory);
    const snapshotBytes = Number(source.pragma("page_count", { simple: true }))
      * Number(source.pragma("page_size", { simple: true }));
    const diskReserveBytes = 256 * 1024 * 1024;
    if (disk.bavail * disk.bsize < snapshotBytes + diskReserveBytes) {
      throw new Error("Insufficient disk space for a backup while preserving space for billing");
    }
    const deadline = Date.now() + 10 * 60 * 1000;
    await source.backup(temporary, {
      progress: () => {
        if (Date.now() > deadline) throw new Error("SQLite backup exceeded its time limit");
        return 32;
      },
    });
  } finally {
    source.close();
  }
  // A published snapshot must be self-contained, with no WAL sidecar needed.
  const snapshot = new Database(temporary, { fileMustExist: true });
  try {
    if (snapshot.pragma("journal_mode = DELETE", { simple: true }) !== "delete"
      || snapshot.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("SQLite backup verification failed");
    }
  } finally {
    snapshot.close();
  }
  const file = await open(temporary, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const destination = path.join(directory, backupName);
  await rename(temporary, destination);
  console.log(`Verified SQLite backup: ${destination}`);

  // Keep one day of half-hourly snapshots. Prune only after publishing a good backup.
  const snapshots = (await readdir(directory))
    .filter((name) => /^pos-\d{4}-\d{2}-\d{2}T[\dZ-]+-[\da-f-]{36}\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const name of snapshots.slice(48)) {
    await rm(path.join(directory, name), { force: true });
  }
} finally {
  await rm(temporary, { force: true });
}
