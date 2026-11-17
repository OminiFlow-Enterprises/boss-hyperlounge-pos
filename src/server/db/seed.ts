import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { uuid, nowIso } from "../lib/ids.js";
import { rupeesToPaise } from "../../shared/money.js";

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = scryptSync(pin, salt, 32);
  const expected = Buffer.from(hash, "hex");
  if (check.length !== expected.length) return false;
  return timingSafeEqual(check, expected);
}

export interface SeedResult {
  staff: Record<string, string>;
  terminals: { pos: string };
  floors: { floor1: string; vip: string };
  tables: Record<string, string>;
  products: Record<string, string>;
  cardTypes: Record<string, string>;
}

const EXTRA_MENU: Array<[string, string, "KITCHEN" | "BAR", number]> = [
  ["FOOD-KC", "KADHAI CHICKEN", "KITCHEN", 450],
  ["FOOD-KP", "KALONGI PANEER", "KITCHEN", 420],
  ["FOOD-KF", "KALONGI FISH CURRY", "KITCHEN", 480],
  ["BAR-KL", "KALUHA", "BAR", 350],
  ["BAR-KM", "KAMIKAZE", "BAR", 400],
  ["FOOD-KG", "KATHAL GALOUTI", "KITCHEN", 390],
  ["FOOD-KK", "KESAR PISTA KULFI", "KITCHEN", 180],
  ["BAR-K30", "KETEL ONE 30 ML", "BAR", 350],
  ["BAR-KBT", "KETEL ONE BTL", "BAR", 4500],
  ["BAR-KO", "KEWRA ORCHARD COOLER", "BAR", 320],
  ["BAR-KPB", "KINGFISHER PREMIUM BUCKET", "BAR", 900],
  ["BAR-KPP", "KINGFISHER PREMIUM PINT", "BAR", 250],
  ["BAR-KUB", "KINGFISHER ULTRA BUCKET", "BAR", 1100],
  ["BAR-KUP", "KINGFISHER ULTRA PINT", "BAR", 280],
  ["FOOD-KA", "KIWI APPLE SMOOTHIE", "KITCHEN", 220],
  ["FOOD-KB", "KIWI BANANA BOWL", "KITCHEN", 240],
  ["BAR-KS", "Kiwi Masala Spark", "BAR", 300],
  ["FOOD-KKK", "KKK", "KITCHEN", 350],
  ["FOOD-KS", "KONJEE SHITAKE MUSHROOM", "KITCHEN", 460],
];

export function seedIfEmpty(db: Database.Database): SeedResult | null {
  const count = db.prepare("SELECT COUNT(*) AS n FROM staff").get() as { n: number };
  if (count.n > 0) {
    ensureProductCatalog(db);
    return null;
  }
  return seedFresh(db);
}

export function ensureProductCatalog(db: Database.Database) {
  const kitchen = db.prepare("SELECT id FROM categories WHERE station = 'KITCHEN' LIMIT 1").get() as { id: string } | undefined;
  const bar = db.prepare("SELECT id FROM categories WHERE station = 'BAR' LIMIT 1").get() as { id: string } | undefined;
  if (!kitchen || !bar) return;
  const exists = db.prepare("SELECT id FROM products WHERE sku = ?");
  const insert = db.prepare(
    `INSERT INTO products (id, sku, name, category_id, station, base_price, tax_rate, track_inventory, unit, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pc', 1)`,
  );
  const stock = db.prepare("INSERT INTO inventory (product_id, quantity, reserved) VALUES (?, ?, 0)");
  for (const [sku, name, station, price] of EXTRA_MENU) {
    if (exists.get(sku)) continue;
    const id = uuid();
    insert.run(id, sku, name, station === "BAR" ? bar.id : kitchen.id, station, rupeesToPaise(price), station === "BAR" ? 18 : 5);
    stock.run(id, 200);
  }
  db.prepare("UPDATE products SET tax_rate = 5 WHERE station = 'KITCHEN' AND (tax_rate IS NULL OR tax_rate = 0)").run();
  db.prepare("UPDATE products SET tax_rate = 18 WHERE station = 'BAR' AND (tax_rate IS NULL OR tax_rate = 0)").run();
}

export function seedFresh(db: Database.Database): SeedResult {
  const now = nowIso();
  const staff: Record<string, string> = {};
  const people: Array<[string, string, string, string]> = [
    ["owner", "Aarav Mehta", "OWNER", "0000"],
    ["manager", "Diya Kapoor", "MANAGER", "1111"],
    ["cashier", "Kabir Shah", "CASHIER", "2222"],
    ["waiter", "Rohan Iyer", "WAITER", "3333"],
    ["kitchen", "Chef Nair", "KITCHEN", "4444"],
    ["bar", "Mixologist Reva", "BAR", "5555"],
  ];
  for (const [key, name, role, pin] of people) {
    const id = uuid();
    staff[key] = id;
    db.prepare(
      "INSERT INTO staff (id, name, username, pin_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    ).run(id, name, key, hashPin(pin), role, now);
  }

  const posTerminal = uuid();
  db.prepare("INSERT INTO terminals (id, name, location) VALUES (?, ?, ?)").run(
    posTerminal,
    "POS-01",
    "Front Desk",
  );

  const cardTypes: Record<string, string> = {};
  const types: Array<[string, string, number, number]> = [
    ["REGULAR", "Regular", 0, 0],
    ["MEMBER", "Member", 5, 10],
    ["VIP", "VIP", 10, 15],
    ["CORPORATE", "Corporate", 8, 12],
  ];
  for (const [code, name, disc, bonus] of types) {
    const id = uuid();
    cardTypes[code] = id;
    db.prepare(
      "INSERT INTO card_types (id, code, name, product_discount_pct, recharge_bonus_pct) VALUES (?, ?, ?, ?, ?)",
    ).run(id, code, name, disc, bonus);
  }

  db.prepare(
    `INSERT INTO bonus_rules
      (id, card_type_id, name, min_recharge, bonus_type, bonus_value, max_bonus, expiry_days, active)
     VALUES (?, ?, ?, ?, 'FLAT', ?, ?, 30, 1)`,
  ).run(uuid(), cardTypes.MEMBER, "Member ₹5,000 + ₹500", rupeesToPaise(5000), rupeesToPaise(500), rupeesToPaise(500));

  db.prepare(
    `INSERT INTO bonus_rules
      (id, card_type_id, name, min_recharge, bonus_type, bonus_value, max_bonus, expiry_days, active)
     VALUES (?, ?, ?, ?, 'PERCENT', ?, ?, 30, 1)`,
  ).run(uuid(), cardTypes.VIP, "VIP 15% bonus", rupeesToPaise(2000), 15, rupeesToPaise(3000));

  const floor1 = uuid();
  const vip = uuid();
  db.prepare("INSERT INTO floors (id, name, sort_order) VALUES (?, ?, ?)").run(floor1, "FLOOR 1", 1);
  db.prepare("INSERT INTO floors (id, name, sort_order) VALUES (?, ?, ?)").run(vip, "VIP AREA", 2);

  const tables: Record<string, string> = {};
  for (let i = 1; i <= 16; i++) {
    const code = String(i).padStart(2, "0");
    const id = uuid();
    tables[code] = id;
    db.prepare(
      "INSERT INTO dining_tables (id, floor_id, code, name, capacity, status, outlet) VALUES (?, ?, ?, ?, ?, 'AVAILABLE', 'BAR')",
    ).run(id, floor1, code, `Table ${code}`, i === 12 ? 8 : 4);
  }
  for (let i = 1; i <= 4; i++) {
    const code = `V0${i}`;
    const id = uuid();
    tables[code] = id;
    db.prepare(
      "INSERT INTO dining_tables (id, floor_id, code, name, capacity, status, outlet) VALUES (?, ?, ?, ?, ?, 'AVAILABLE', 'BAR')",
    ).run(id, vip, code, `Table ${code}`, 6);
  }

  const kitchenCat = uuid();
  const barCat = uuid();
  db.prepare("INSERT INTO categories (id, name, station) VALUES (?, ?, ?)").run(kitchenCat, "Food", "KITCHEN");
  db.prepare("INSERT INTO categories (id, name, station) VALUES (?, ?, ?)").run(barCat, "Drinks", "BAR");

  const products: Record<string, string> = {};
  const catalog: Array<[string, string, string, string, number, number, number]> = [
    ["FOOD-PT", "Paneer Tikka", kitchenCat, "KITCHEN", 400, 5, 80],
    ["FOOD-PZ", "Pizza", kitchenCat, "KITCHEN", 600, 5, 40],
    ["FOOD-FF", "French Fries", kitchenCat, "KITCHEN", 200, 5, 60],
    ["BAR-WH", "Whisky", barCat, "BAR", 300, 18, 100],
    ["BAR-CK", "Cocktail", barCat, "BAR", 700, 18, 80],
    ["BAR-BE", "Beer", barCat, "BAR", 250, 18, 120],
    ...EXTRA_MENU.map(([sku, name, station, price]) =>
      [sku, name, station === "BAR" ? barCat : kitchenCat, station, price, station === "BAR" ? 18 : 5, 200] as [string, string, string, string, number, number, number],
    ),
  ];
  for (const [sku, name, cat, station, price, tax, qty] of catalog) {
    const id = uuid();
    products[sku] = id;
    db.prepare(
      `INSERT INTO products (id, sku, name, category_id, station, base_price, tax_rate, track_inventory, unit, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pc', 1)`,
    ).run(id, sku, name, cat, station, rupeesToPaise(price), tax);
    db.prepare("INSERT INTO inventory (product_id, quantity, reserved) VALUES (?, ?, 0)").run(id, qty);
  }

  db.prepare(
    "INSERT INTO product_prices (id, product_id, card_type_id, price) VALUES (?, ?, ?, ?)",
  ).run(uuid(), products["BAR-WH"], cardTypes.VIP, rupeesToPaise(250));
  db.prepare(
    "INSERT INTO product_prices (id, product_id, card_type_id, price) VALUES (?, ?, ?, ?)",
  ).run(uuid(), products["BAR-CK"], cardTypes.MEMBER, rupeesToPaise(650));

  const hh = uuid();
  db.prepare(
    "INSERT INTO happy_hours (id, name, start_time, end_time, days_of_week, active) VALUES (?, ?, ?, ?, ?, 1)",
  ).run(hh, "Happy Hour", "17:00", "19:00", "1,2,3,4,5,6,7");
  db.prepare(
    "INSERT INTO happy_hour_prices (id, happy_hour_id, product_id, price) VALUES (?, ?, ?, ?)",
  ).run(uuid(), hh, products["BAR-WH"], rupeesToPaise(200));

  const settings: Array<[string, string]> = [
    ["service_charge_pct", "10"],
    ["service_charge_mode", "EXCLUSIVE"],
    ["venue_name", "BOSS Hyperlounge"],
    ["spend_bonus_first", "1"],
    ["cloud_sync_url", ""],
    ["offline_mode", "0"],
    ["insufficient_balance_actions", "recharge,split,cancel"],
    ["day_close_hour", "6"],
  ];
  for (const [key, value] of settings) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  return {
    staff,
    terminals: { pos: posTerminal },
    floors: { floor1, vip },
    tables,
    products,
    cardTypes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDatabase } = await import("./database.js");
  const db = openDatabase();
  const result = seedIfEmpty(db);
  console.log(result ? "Seeded BOSS Hyperlounge POS" : "Database already seeded");
  db.close();
}
