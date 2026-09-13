import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface OpenDbOptions {
  filePath?: string;
  memory?: boolean;
}

export function openDatabase(options: OpenDbOptions = {}): Database.Database {
  const db = options.memory
    ? new Database(":memory:")
    : new Database(options.filePath ?? defaultDbPath());

  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function defaultDbPath(): string {
  const dir = path.resolve(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "hyperlounge.sqlite");
}

export function migrate(db: Database.Database): void {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);
}

export function resetDatabase(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS day_closes;
    DROP TABLE IF EXISTS sync_queue;
    DROP TABLE IF EXISTS audit_log;
    DROP TABLE IF EXISTS settings;
    DROP TABLE IF EXISTS refunds;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS invoice_items;
    DROP TABLE IF EXISTS invoices;
    DROP TABLE IF EXISTS kot_reprints;
    DROP TABLE IF EXISTS kot_items;
    DROP TABLE IF EXISTS kots;
    DROP TABLE IF EXISTS order_items;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS expenses;
    DROP TABLE IF EXISTS purchase_items;
    DROP TABLE IF EXISTS purchases;
    DROP TABLE IF EXISTS inventory_movements;
    DROP TABLE IF EXISTS inventory;
    DROP TABLE IF EXISTS happy_hour_prices;
    DROP TABLE IF EXISTS happy_hours;
    DROP TABLE IF EXISTS product_prices;
    DROP TABLE IF EXISTS products;
    DROP TABLE IF EXISTS categories;
    DROP TABLE IF EXISTS table_splits;
    DROP TABLE IF EXISTS table_merges;
    DROP TABLE IF EXISTS table_transfers;
    DROP TABLE IF EXISTS checkins;
    DROP TABLE IF EXISTS table_sessions;
    DROP TABLE IF EXISTS dining_tables;
    DROP TABLE IF EXISTS floors;
    DROP TABLE IF EXISTS bonus_rules;
    DROP TABLE IF EXISTS card_swaps;
    DROP TABLE IF EXISTS card_ledger;
    DROP TABLE IF EXISTS member_cards;
    DROP TABLE IF EXISTS card_types;
    DROP TABLE IF EXISTS customers;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS staff;
    DROP TABLE IF EXISTS terminals;
    DROP TABLE IF EXISTS sequences;
    PRAGMA foreign_keys = ON;
  `);
  migrate(db);
}
