import { assertPermission } from "../../shared/permissions.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { nowIso, uuid } from "../lib/ids.js";
import { hashPin, verifyPin } from "../db/seed.js";
import type { Actor, StaffRole } from "../../shared/types.js";

export function login(ctx: AppContext, username: string, pin: string, terminalId: string): Actor {
  const staff = ctx.db
    .prepare("SELECT * FROM staff WHERE username = ? AND active = 1")
    .get(username.trim()) as
    | { id: string; name: string; pin_hash: string; role: StaffRole }
    | undefined;
  if (!staff || !verifyPin(pin, staff.pin_hash)) {
    throw new AppError("Invalid staff PIN", 401, "AUTH_FAILED");
  }
  const terminal = ctx.db.prepare("SELECT * FROM terminals WHERE id = ?").get(terminalId) as
    | { id: string; name: string }
    | undefined;
  if (!terminal) throw new AppError("Unknown terminal");
  ctx.db
    .prepare("INSERT INTO sessions (id, staff_id, terminal_id, started_at) VALUES (?, ?, ?, ?)")
    .run(uuid(), staff.id, terminal.id, nowIso());
  return {
    staffId: staff.id,
    staffName: staff.name,
    role: staff.role,
    terminalId: terminal.id,
    terminalName: terminal.name,
  };
}

export function listStaff(ctx: AppContext) {
  return ctx.db
    .prepare("SELECT id, name, username, role, active, created_at FROM staff ORDER BY name")
    .all();
}

export function createStaff(
  ctx: AppContext,
  input: { name: string; username: string; pin: string; role: StaffRole },
) {
  assertPermission(ctx.actor.role, "MANAGE_STAFF");
  const id = uuid();
  ctx.db
    .prepare(
      "INSERT INTO staff (id, name, username, pin_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    )
    .run(id, input.name, input.username, hashPin(input.pin), input.role, nowIso());
  audit(ctx, "STAFF_CREATE", "staff", id, null, null, { username: input.username, role: input.role });
  return { id };
}

export function listProducts(ctx: AppContext) {
  return ctx.db
    .prepare(
      `SELECT p.*, c.name AS category_name
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1
       ORDER BY p.station, p.name`,
    )
    .all();
}

export function listCustomers(ctx: AppContext, query?: string) {
  if (!query) return ctx.db.prepare("SELECT * FROM customers ORDER BY created_at DESC").all();
  const q = `%${query}%`;
  return ctx.db.prepare("SELECT * FROM customers WHERE name LIKE ? OR mobile LIKE ? ORDER BY name").all(q, q);
}

export function listCardTypes(ctx: AppContext) {
  return ctx.db.prepare("SELECT * FROM card_types ORDER BY name").all();
}

export function listBonusRules(ctx: AppContext) {
  return ctx.db.prepare("SELECT * FROM bonus_rules ORDER BY min_recharge").all();
}

export function upsertBonusRule(
  ctx: AppContext,
  input: {
    id?: string;
    cardTypeId?: string | null;
    name: string;
    minRecharge: number;
    bonusType: "FLAT" | "PERCENT";
    bonusValue: number;
    maxBonus?: number | null;
    expiryDays?: number | null;
    active?: boolean;
  },
) {
  assertPermission(ctx.actor.role, "SETTINGS");
  const id = input.id ?? uuid();
  const existing = ctx.db.prepare("SELECT id FROM bonus_rules WHERE id = ?").get(id);
  if (existing) {
    ctx.db
      .prepare(
        `UPDATE bonus_rules SET card_type_id=?, name=?, min_recharge=?, bonus_type=?, bonus_value=?, max_bonus=?, expiry_days=?, active=?
         WHERE id=?`,
      )
      .run(
        input.cardTypeId ?? null,
        input.name,
        input.minRecharge,
        input.bonusType,
        input.bonusValue,
        input.maxBonus ?? null,
        input.expiryDays ?? null,
        input.active === false ? 0 : 1,
        id,
      );
  } else {
    ctx.db
      .prepare(
        `INSERT INTO bonus_rules (id, card_type_id, name, min_recharge, bonus_type, bonus_value, max_bonus, expiry_days, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.cardTypeId ?? null,
        input.name,
        input.minRecharge,
        input.bonusType,
        input.bonusValue,
        input.maxBonus ?? null,
        input.expiryDays ?? null,
        input.active === false ? 0 : 1,
      );
  }
  return ctx.db.prepare("SELECT * FROM bonus_rules WHERE id = ?").get(id);
}
