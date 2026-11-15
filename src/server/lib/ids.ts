import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export function uuid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Lounge day starts at `hour` local time (default 6:00). Before 6 AM belongs to the previous day. */
export function businessDayStart(now = new Date(), hour = 6): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (now.getTime() < start.getTime()) start.setDate(start.getDate() - 1);
  return start;
}

export function idempotencyKey(prefix = "idm"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function nextSequence(db: Database.Database, name: string, start = 10001): number {
  const row = db.prepare("SELECT value FROM sequences WHERE name = ?").get(name) as
    | { value: number }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO sequences (name, value) VALUES (?, ?)").run(name, start);
    return start;
  }
  const next = row.value + 1;
  db.prepare("UPDATE sequences SET value = ? WHERE name = ?").run(next, name);
  return next;
}

export function nextNumber(db: Database.Database, name: string, prefix: string, start = 10001): string {
  return `${prefix}${nextSequence(db, name, start)}`;
}
