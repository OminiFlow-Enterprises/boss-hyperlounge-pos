import { mkdir, open, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const { filename } = workerData.data as { filename: string };
const directory = path.join(path.dirname(path.dirname(path.resolve(filename))), "backups");
const startedAt = new Date();
const backupName = `pos-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.sqlite`;
const temporary = path.join(directory, `${backupName}.partial`);

async function listSnapshots() {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^pos-\d{4}-\d{2}-\d{2}T[\dZ-]+-[\da-f-]{36}\.sqlite$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

function isVerifiedSnapshot(filename: string) {
  try {
    const snapshot = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      return snapshot.pragma("journal_mode", { simple: true }) === "delete" &&
        snapshot.pragma("quick_check", { simple: true }) === "ok";
    } finally {
      snapshot.close();
    }
  } catch {
    return false;
  }
}

async function pruneSnapshots(snapshots: string[], keep: string) {
  for (const name of snapshots) {
    if (name !== keep) await rm(path.join(directory, name), { force: true });
  }
}

async function backupDaily() {
  await mkdir(directory, { recursive: true });
  const snapshots = await listSnapshots();
  if (snapshots.length) {
    const latest = path.join(directory, snapshots[0]);
    const metadata = await stat(latest).catch(() => undefined);
    if (metadata?.mtime.toDateString() === startedAt.toDateString() && isVerifiedSnapshot(latest)) {
      await pruneSnapshots(snapshots, snapshots[0]);
      return;
    }
  }

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

    const published = await listSnapshots();
    const newestVerified = published.find((name) => name === backupName || isVerifiedSnapshot(path.join(directory, name)));
    if (newestVerified) await pruneSnapshots(published, newestVerified);
  } finally {
    await rm(temporary, { force: true });
  }
}

await backupDaily();
