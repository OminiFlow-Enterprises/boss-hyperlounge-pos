import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { openDatabase } from "../src/server/db/database.js";

it("backs up and migrates an existing database once without replacing its records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-migration-"));
  const filePath = path.join(dir, "hyperlounge.sqlite");
  const legacy = new Database(filePath);
  legacy.exec("CREATE TABLE existing_records (value TEXT); INSERT INTO existing_records VALUES ('saved record')");
  legacy.close();

  function inspect() {
    const db = openDatabase({ filePath });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(4);
      expect(db.prepare("SELECT value FROM existing_records").pluck().get()).toBe("saved record");
    } finally {
      db.close();
    }
  }

  try {
    inspect();
    const backupDir = path.join(dir, "migration-backups");
    const backups = fs.readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    const backup = new Database(path.join(backupDir, backups[0]), { readonly: true });
    try {
      expect(backup.pragma("user_version", { simple: true })).toBe(0);
      expect(backup.prepare("SELECT value FROM existing_records").pluck().get()).toBe("saved record");
    } finally {
      backup.close();
    }
    inspect();
    expect(fs.readdirSync(backupDir)).toEqual(backups);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
