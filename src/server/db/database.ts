import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { nextSequence } from "../lib/ids.js";

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
  importBundledComplimentaryAccounts(db);
  return db;
}

export function defaultDbPath(): string {
  const dir = process.env.POS_DATA_DIR
    ? path.resolve(process.env.POS_DATA_DIR)
    : path.resolve(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "hyperlounge.sqlite");
}

function importBundledComplimentaryAccounts(db: Database.Database): void {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return;

  const seedPath = path.join(resourcesPath, "data", "hyperlounge.sqlite");
  if (!fs.existsSync(seedPath)) return;

  let seed: Database.Database | undefined;
  try {
    seed = new Database(seedPath, { readonly: true, fileMustExist: true });
    const seedAccounts = seed
      .prepare("SELECT id, code, name, created_at FROM complimentary_accounts ORDER BY code")
      .all() as Array<{ id: string; code: number; name: string; created_at: string }>;
    if (seedAccounts.length === 0) return;

    const count = (db.prepare("SELECT COUNT(*) AS count FROM complimentary_accounts").get() as { count: number }).count;
    if (count !== 0) return;

    const insert = db.prepare(
      "INSERT OR IGNORE INTO complimentary_accounts (id, code, name, created_at) VALUES (?, ?, ?, ?)",
    );
    const importAccounts = db.transaction(() => {
      for (const account of seedAccounts) {
        insert.run(account.id, account.code, account.name, account.created_at);
      }
    });
    importAccounts();
  } catch {
    // The bundled seed may be absent or from an older version without this table.
  } finally {
    seed?.close();
  }
}

function separateTableCodesByOutlet(db: Database.Database) {
  if (!hasColumn(db, "dining_tables", "outlet")) return;
  const indexes = db.prepare("PRAGMA index_list(dining_tables)").all() as Array<{ name: string; unique: number; origin: string }>;
  const codeOnly = indexes.some((idx) => {
    if (!idx.unique || idx.origin === "pk") return false;
    const cols = db.prepare(`PRAGMA index_info('${idx.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>;
    return cols.length === 1 && cols[0]?.name === "code";
  });
  if (!codeOnly) return;
  db.pragma("foreign_keys = OFF");
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE dining_tables_new (
        id TEXT PRIMARY KEY,
        floor_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 4,
        status TEXT NOT NULL DEFAULT 'AVAILABLE',
        current_session_id TEXT,
        merged_into_table_id TEXT,
        outlet TEXT NOT NULL DEFAULT 'BAR',
        UNIQUE(outlet, code)
      );
      INSERT INTO dining_tables_new (id, floor_id, code, name, capacity, status, current_session_id, merged_into_table_id, outlet)
      SELECT id, floor_id, code, name, capacity, status, current_session_id, merged_into_table_id, COALESCE(outlet, 'BAR')
      FROM dining_tables;
      DROP TABLE dining_tables;
      ALTER TABLE dining_tables_new RENAME TO dining_tables;
    `);
  });
  rebuild();
  db.pragma("foreign_keys = ON");
}

function hasColumn(db: Database.Database, table: string, column: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export function migrate(db: Database.Database): void {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);
  if (hasColumn(db, "dining_tables", "id") && !hasColumn(db, "dining_tables", "outlet")) {
    db.exec("ALTER TABLE dining_tables ADD COLUMN outlet TEXT NOT NULL DEFAULT 'BAR'");
  }
  if (hasColumn(db, "table_sessions", "id") && !hasColumn(db, "table_sessions", "outlet")) {
    db.exec("ALTER TABLE table_sessions ADD COLUMN outlet TEXT NOT NULL DEFAULT 'BAR'");
  }
  separateTableCodesByOutlet(db);
  const productCols: Array<[string, string]> = [
    ["sales_group", "TEXT NOT NULL DEFAULT ''"],
    ["item_group", "TEXT NOT NULL DEFAULT ''"],
    ["cost_price", "INTEGER NOT NULL DEFAULT 0"],
    ["is_veg", "INTEGER NOT NULL DEFAULT 1"],
    ["stock_item", "TEXT NOT NULL DEFAULT ''"],
    ["allow_complimentary", "INTEGER NOT NULL DEFAULT 0"],
    ["hide_in_web", "INTEGER NOT NULL DEFAULT 0"],
    ["name_hindi", "TEXT NOT NULL DEFAULT ''"],
    ["mix_item", "INTEGER NOT NULL DEFAULT 0"],
    ["logo", "TEXT NOT NULL DEFAULT ''"],
  ];
  if (hasColumn(db, "products", "id")) {
    for (const [name, def] of productCols) {
      if (!hasColumn(db, "products", name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${def}`);
    }
  }
  if (hasColumn(db, "payments", "id")) {
    if (!hasColumn(db, "payments", "remark")) db.exec("ALTER TABLE payments ADD COLUMN remark TEXT NOT NULL DEFAULT ''");
    if (!hasColumn(db, "payments", "receipt_no")) db.exec("ALTER TABLE payments ADD COLUMN receipt_no INTEGER");
    if (!hasColumn(db, "payments", "voucher_no")) db.exec("ALTER TABLE payments ADD COLUMN voucher_no INTEGER");
    const missing = db
      .prepare("SELECT id FROM payments WHERE receipt_no IS NULL OR voucher_no IS NULL ORDER BY created_at, id")
      .all() as Array<{ id: string }>;
    const fill = db.prepare("UPDATE payments SET receipt_no = COALESCE(receipt_no, ?), voucher_no = COALESCE(voucher_no, ?) WHERE id = ?");
    for (const row of missing) {
      fill.run(nextSequence(db, "settlement_receipt", 32901), nextSequence(db, "settlement_voucher", 47201), row.id);
    }
  }
  if (hasColumn(db, "invoices", "id")) {
    if (!hasColumn(db, "invoices", "complimentary_account_id")) {
      db.exec("ALTER TABLE invoices ADD COLUMN complimentary_account_id TEXT");
    }
    if (!hasColumn(db, "invoices", "complimentary_name")) {
      db.exec("ALTER TABLE invoices ADD COLUMN complimentary_name TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(db, "invoices", "customer_display_name")) db.exec("ALTER TABLE invoices ADD COLUMN customer_display_name TEXT NOT NULL DEFAULT ''");
    if (!hasColumn(db, "invoices", "bill_details")) db.exec("ALTER TABLE invoices ADD COLUMN bill_details TEXT NOT NULL DEFAULT '{}'");
    if (!hasColumn(db, "invoices", "customer_gstin")) db.exec("ALTER TABLE invoices ADD COLUMN customer_gstin TEXT NOT NULL DEFAULT ''");
  }
  if (hasColumn(db, "staff", "id")) {
    const staffCols: Array<[string, string]> = [
      ["user_role", "TEXT"],
      ["discount_pct", "REAL"],
      ["old_date_record", "INTEGER"],
      ["mis_report", "TEXT"],
      ["hide_collection", "INTEGER"],
      ["hide_estimate", "INTEGER"],
      ["allow_complementary", "INTEGER"],
      ["advance_card_update", "INTEGER"],
      ["show_checkin_rooms", "INTEGER"],
      ["bill_flags", "TEXT"],
      ["rights_json", "TEXT"],
      ["outlet_rights", "TEXT"],
    ];
    for (const [name, def] of staffCols) {
      if (!hasColumn(db, "staff", name)) db.exec(`ALTER TABLE staff ADD COLUMN ${name} ${def}`);
    }
  }
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
    DROP TABLE IF EXISTS product_dept_rates;
    DROP TABLE IF EXISTS item_groups;
    DROP TABLE IF EXISTS sales_groups;
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
    DROP TABLE IF EXISTS complimentary_accounts;
    DROP TABLE IF EXISTS customers;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS staff;
    DROP TABLE IF EXISTS terminals;
    DROP TABLE IF EXISTS bookings;
    DROP TABLE IF EXISTS sequences;
    PRAGMA foreign_keys = ON;
  `);
  migrate(db);
}
