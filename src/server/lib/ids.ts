import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { businessDate } from "../../shared/businessDate.js";

export function uuid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export { businessDate as todayDate, businessDayStart } from "../../shared/businessDate.js";

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

/** Next number that `nextNumber` will issue. Does not move the sequence. */
export function peekNextNumber(db: Database.Database, name: string, prefix: string, start = 10001): string {
  const row = db.prepare("SELECT value FROM sequences WHERE name = ?").get(name) as
    | { value: number }
    | undefined;
  return `${prefix}${row ? row.value + 1 : start}`;
}

/** Indian FY label, e.g. Nov 2026 → `26-27/` for bill nos like `26-27/10022`. */
export function financialYearPrefix(d = new Date()): string {
  const date = businessDate(d, 0);
  const year = Number(date.slice(0, 4));
  const fyStart = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  const a = String(fyStart).slice(-2);
  const b = String(fyStart + 1).slice(-2);
  return `${a}-${b}/`;
}

export function nextBillNumber(db: Database.Database, d = new Date()): string {
  return nextNumber(db, "invoice", financialYearPrefix(d));
}

export function peekNextBillNumber(db: Database.Database, d = new Date()): string {
  return peekNextNumber(db, "invoice", financialYearPrefix(d));
}
