PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'Lounge'
);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  terminal_id TEXT NOT NULL REFERENCES terminals(id),
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mobile TEXT NOT NULL UNIQUE,
  email TEXT,
  member_type TEXT NOT NULL DEFAULT 'REGULAR',
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_types (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  product_discount_pct REAL NOT NULL DEFAULT 0,
  recharge_bonus_pct REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS member_cards (
  id TEXT PRIMARY KEY,
  card_number TEXT NOT NULL UNIQUE,
  card_uid TEXT UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  card_type_id TEXT NOT NULL REFERENCES card_types(id),
  opening_paid_balance INTEGER NOT NULL DEFAULT 0,
  opening_bonus_balance INTEGER NOT NULL DEFAULT 0,
  paid_balance INTEGER NOT NULL DEFAULT 0,
  bonus_balance INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expiry_date TEXT,
  replaced_by_card_id TEXT,
  block_reason TEXT
);

CREATE TABLE IF NOT EXISTS card_ledger (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  card_id TEXT NOT NULL REFERENCES member_cards(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL,
  direction TEXT NOT NULL,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  bonus_amount INTEGER NOT NULL DEFAULT 0,
  previous_paid INTEGER NOT NULL,
  previous_bonus INTEGER NOT NULL,
  new_paid INTEGER NOT NULL,
  new_bonus INTEGER NOT NULL,
  payment_mode TEXT,
  cashier_id TEXT REFERENCES staff(id),
  terminal_id TEXT REFERENCES terminals(id),
  reference_number TEXT,
  related_ledger_id TEXT,
  related_invoice_id TEXT,
  related_card_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_card ON card_ledger(card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON card_ledger(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON card_ledger(type, created_at);

CREATE TABLE IF NOT EXISTS card_swaps (
  id TEXT PRIMARY KEY,
  old_card_id TEXT NOT NULL REFERENCES member_cards(id),
  new_card_id TEXT NOT NULL REFERENCES member_cards(id),
  transferred_paid INTEGER NOT NULL,
  transferred_bonus INTEGER NOT NULL,
  reason TEXT NOT NULL,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  approver_id TEXT REFERENCES staff(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bonus_rules (
  id TEXT PRIMARY KEY,
  card_type_id TEXT REFERENCES card_types(id),
  name TEXT NOT NULL,
  min_recharge INTEGER NOT NULL DEFAULT 0,
  bonus_type TEXT NOT NULL DEFAULT 'FLAT',
  bonus_value INTEGER NOT NULL DEFAULT 0,
  max_bonus INTEGER,
  expiry_days INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_to TEXT
);

CREATE TABLE IF NOT EXISTS floors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id TEXT PRIMARY KEY,
  floor_id TEXT NOT NULL REFERENCES floors(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  current_session_id TEXT,
  merged_into_table_id TEXT
);

CREATE TABLE IF NOT EXISTS table_sessions (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES dining_tables(id),
  customer_id TEXT REFERENCES customers(id),
  card_id TEXT REFERENCES member_cards(id),
  waiter_id TEXT REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  card_id TEXT REFERENCES member_cards(id),
  table_id TEXT NOT NULL REFERENCES dining_tables(id),
  session_id TEXT NOT NULL REFERENCES table_sessions(id),
  waiter_id TEXT REFERENCES staff(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS table_transfers (
  id TEXT PRIMARY KEY,
  from_table_id TEXT NOT NULL,
  to_table_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS table_merges (
  id TEXT PRIMARY KEY,
  source_table_id TEXT NOT NULL,
  target_table_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS table_splits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  station TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  station TEXT NOT NULL,
  base_price INTEGER NOT NULL,
  tax_rate REAL NOT NULL DEFAULT 0,
  track_inventory INTEGER NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'pc',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  card_type_id TEXT NOT NULL REFERENCES card_types(id),
  price INTEGER NOT NULL,
  UNIQUE(product_id, card_type_id)
);

CREATE TABLE IF NOT EXISTS happy_hours (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  days_of_week TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS happy_hour_prices (
  id TEXT PRIMARY KEY,
  happy_hour_id TEXT NOT NULL REFERENCES happy_hours(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  price INTEGER NOT NULL,
  UNIQUE(happy_hour_id, product_id)
);

CREATE TABLE IF NOT EXISTS inventory (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  supplier TEXT NOT NULL,
  total INTEGER NOT NULL,
  staff_id TEXT REFERENCES staff(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  cost INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT,
  staff_id TEXT REFERENCES staff(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES table_sessions(id),
  table_id TEXT NOT NULL REFERENCES dining_tables(id),
  waiter_id TEXT REFERENCES staff(id),
  customer_id TEXT REFERENCES customers(id),
  card_id TEXT REFERENCES member_cards(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  station TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  tax_rate REAL NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  kot_id TEXT,
  split_group TEXT,
  voided INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kots (
  id TEXT PRIMARY KEY,
  kot_number TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  session_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  waiter_id TEXT,
  station TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'NEW',
  status TEXT NOT NULL DEFAULT 'NEW',
  reprint_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  sent_at TEXT,
  accepted_at TEXT,
  preparing_at TEXT,
  ready_at TEXT,
  served_at TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kot_items (
  id TEXT PRIMARY KEY,
  kot_id TEXT NOT NULL REFERENCES kots(id),
  order_item_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS kot_reprints (
  id TEXT PRIMARY KEY,
  kot_id TEXT NOT NULL REFERENCES kots(id),
  staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  customer_id TEXT,
  card_id TEXT,
  food_total INTEGER NOT NULL DEFAULT 0,
  drinks_total INTEGER NOT NULL DEFAULT 0,
  service_charge INTEGER NOT NULL DEFAULT 0,
  service_charge_mode TEXT NOT NULL DEFAULT 'EXCLUSIVE',
  service_charge_pct REAL NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  other_charges INTEGER NOT NULL DEFAULT 0,
  grand_total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNPAID',
  cashier_id TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  order_item_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  station TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  amount INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,
  member_card_id TEXT,
  ledger_id TEXT,
  reference TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  payment_id TEXT REFERENCES payments(id),
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,
  ledger_id TEXT,
  staff_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  user_id TEXT,
  user_name TEXT,
  terminal_id TEXT,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);

CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS day_closes (
  id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL UNIQUE,
  opening_liability INTEGER NOT NULL,
  recharges INTEGER NOT NULL,
  bonuses INTEGER NOT NULL,
  purchases INTEGER NOT NULL,
  refunds INTEGER NOT NULL,
  adjustments INTEGER NOT NULL,
  expected_closing INTEGER NOT NULL,
  actual_closing INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
