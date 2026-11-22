import { assertPermission } from "../../shared/permissions.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { nowIso, uuid } from "../lib/ids.js";
import { hashPin, verifyPin } from "../db/seed.js";
import type { Actor, StaffRole } from "../../shared/types.js";
import {
  billPreset,
  blankOutlets,
  flagsPreset,
  mergeOutlets,
  rightsPreset,
  isUserRoleLabel,
  roleLabel,
  type BillFlags,
  type OutletRight,
  type UserFlags,
  type UserRoleLabel,
} from "../../shared/userRights.js";
import { groupReportOverrides } from "./settingsService.js";
import { deptRatesByProduct } from "./itemService.js";

type StaffRow = {
  id: string;
  name: string;
  username: string;
  pin_hash: string;
  role: string;
  active: number;
  user_role: string | null;
  discount_pct: number | null;
  old_date_record: number | null;
  mis_report: string | null;
  hide_collection: number | null;
  hide_estimate: number | null;
  allow_complementary: number | null;
  advance_card_update: number | null;
  show_checkin_rooms: number | null;
  bill_flags: string | null;
  rights_json: string | null;
  outlet_rights: string | null;
};

export type StaffInput = {
  name?: string;
  username?: string;
  pin?: string;
  password?: string;
  role?: string;
  userRole?: string;
  discount?: string | number;
  oldDateRecord?: string | number;
  misReport?: string;
  flags?: UserFlags;
  bill?: BillFlags;
  rights?: Record<string, boolean>;
  outlets?: OutletRight[];
};

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function bit(value: number | null): boolean | null {
  if (value == null) return null;
  return Number(value) === 1;
}

function mapStaff(ctx: AppContext, row: StaffRow) {
  const userRole = roleLabel(row.role, row.user_role);
  const fixedGroup = isUserRoleLabel(row.user_role) && row.user_role !== "ADMIN";
  const flagsConfigured = row.hide_collection != null;
  const bill = parseJson<BillFlags>(row.bill_flags);
  const baseRights = fixedGroup ? rightsPreset(userRole) : parseJson<Record<string, boolean>>(row.rights_json);
  const reports = isUserRoleLabel(row.user_role) ? groupReportOverrides(ctx, userRole) : undefined;
  const rights = reports ? { ...(baseRights ?? rightsPreset(userRole)), ...reports, report: Object.values(reports).some(Boolean) } : baseRights;
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    userRole,
    active: row.active,
    configured: row.rights_json != null,
    discount: row.discount_pct == null ? "0.00" : Number(row.discount_pct).toFixed(2),
    oldDateRecord: row.old_date_record == null ? 1 : Number(row.old_date_record),
    misReport: row.mis_report || "Full",
    flags: fixedGroup ? flagsPreset(userRole) : flagsConfigured
      ? {
          hideCollection: bit(row.hide_collection) === true,
          hideEstimate: bit(row.hide_estimate) === true,
          allowComplementary: bit(row.allow_complementary) === true,
          advanceCardUpdate: bit(row.advance_card_update) === true,
        }
      : null,
    bill: fixedGroup ? billPreset(userRole) : bill,
    rights,
    outlets: parseJson<OutletRight[]>(row.outlet_rights),
  };
}

function actorFrom(ctx: AppContext, staff: StaffRow, terminal: { id: string; name: string }): Actor {
  const mapped = mapStaff(ctx, staff);
  return {
    staffId: staff.id,
    staffName: staff.name,
    role: (staff.role as StaffRole) || "CASHIER",
    terminalId: terminal.id,
    terminalName: terminal.name,
    username: staff.username,
    userGroup: isUserRoleLabel(staff.user_role) ? staff.user_role : undefined,
    rights: mapped.rights,
    allowComplementary: mapped.flags ? mapped.flags.allowComplementary : null,
    tableTransfer: mapped.bill ? mapped.bill.tableTransfer : null,
    itemTransfer: mapped.bill ? mapped.bill.itemTransfer : null,
  };
}

function findActive(ctx: AppContext, username: string) {
  return ctx.db
    .prepare("SELECT * FROM staff WHERE lower(username) = lower(?) AND active = 1")
    .get(username.trim()) as StaffRow | undefined;
}

function assertCanManageUsers(ctx: AppContext) {
  const row = ctx.db
    .prepare("SELECT rights_json FROM staff WHERE id = ?")
    .get(ctx.actor.staffId) as { rights_json: string | null } | undefined;
  if (ctx.actor.userGroup && ctx.actor.userGroup !== "ADMIN") throw new AppError("Permission denied", 403);
  if (!row || row.rights_json == null || row.rights_json === "") return;
  const rights = parseJson<Record<string, boolean>>(row.rights_json);
  if (rights && (rights["master.user"] || rights.master)) return;
  throw new AppError("Permission denied", 403, "PERMISSION_DENIED");
}

function userRoleOf(input: StaffInput): UserRoleLabel {
  if (isUserRoleLabel(input.userRole)) return input.userRole;
  if (input.role === "OWNER" || input.role === "MANAGER" || input.role === "ADMIN") return "ADMIN";
  if (input.role) return "OPERATOR";
  throw new AppError("Select user role");
}

function profileOf(input: StaffInput, userRole: UserRoleLabel) {
  const flags = userRole === "ADMIN" && input.flags ? input.flags : flagsPreset(userRole);
  const bill = userRole === "ADMIN" && input.bill ? input.bill : billPreset(userRole);
  const rights = userRole === "ADMIN" && input.rights ? input.rights : rightsPreset(userRole);
  const discount = Number(input.discount ?? 0);
  const oldDate = Math.round(Number(input.oldDateRecord ?? 1));
  const mis = input.misReport === "User" || input.misReport === "None" ? input.misReport : "Full";
  return {
    role: userRole === "ADMIN" || userRole === "CASHIER" ? "OWNER" : "CASHIER",
    userRole,
    discount: Number.isFinite(discount) && discount > 0 ? discount : 0,
    oldDate: Number.isFinite(oldDate) && oldDate > 0 ? oldDate : 1,
    mis,
    flags,
    bill,
    rights,
    outlets: mergeOutlets(input.outlets ?? blankOutlets()),
  };
}

const PROFILE_SQL = `user_role=?, discount_pct=?, old_date_record=?, mis_report=?,
  hide_collection=?, hide_estimate=?, allow_complementary=?, advance_card_update=?, show_checkin_rooms=?,
  bill_flags=?, rights_json=?, outlet_rights=?`;

function profileArgs(profile: ReturnType<typeof profileOf>) {
  return [
    profile.userRole,
    profile.discount,
    profile.oldDate,
    profile.mis,
    profile.flags.hideCollection ? 1 : 0,
    profile.flags.hideEstimate ? 1 : 0,
    profile.flags.allowComplementary ? 1 : 0,
    profile.flags.advanceCardUpdate ? 1 : 0,
    0,
    JSON.stringify(profile.bill),
    JSON.stringify(profile.rights),
    JSON.stringify(profile.outlets),
  ];
}

export function login(ctx: AppContext, username: string, pin: string, terminalId: string): Actor {
  const staff = findActive(ctx, username);
  if (!staff || !verifyPin(pin, staff.pin_hash)) {
    throw new AppError("Invalid Username or Password", 401, "AUTH_FAILED");
  }
  const terminal = ctx.db.prepare("SELECT * FROM terminals WHERE id = ?").get(terminalId) as
    | { id: string; name: string }
    | undefined;
  if (!terminal) throw new AppError("Unknown terminal");
  ctx.db
    .prepare("INSERT INTO sessions (id, staff_id, terminal_id, started_at) VALUES (?, ?, ?, ?)")
    .run(uuid(), staff.id, terminal.id, nowIso());
  return actorFrom(ctx, staff, terminal);
}

export function changePassword(ctx: AppContext, username: string, oldPassword: string, newPassword: string) {
  const name = String(username ?? "").trim();
  const next = String(newPassword ?? "");
  if (!name || !oldPassword || !next) throw new AppError("Enter username and password");
  const staff = findActive(ctx, name);
  if (!staff || !verifyPin(String(oldPassword), staff.pin_hash)) {
    throw new AppError("Invalid Username or Password", 401, "AUTH_FAILED");
  }
  ctx.db.prepare("UPDATE staff SET pin_hash = ? WHERE id = ?").run(hashPin(next), staff.id);
  audit(ctx, "STAFF_PASSWORD", "staff", staff.id, null, null, { username: staff.username });
  return { ok: true };
}

export function listStaff(ctx: AppContext) {
  const rows = ctx.db
    .prepare("SELECT * FROM staff WHERE active = 1 ORDER BY username COLLATE NOCASE")
    .all() as StaffRow[];
  return rows.map((row) => mapStaff(ctx, row));
}

export function createStaff(ctx: AppContext, input: StaffInput) {
  assertCanManageUsers(ctx);
  const username = String(input.username ?? input.name ?? "").trim();
  if (!username) throw new AppError("Enter username");
  const userRole = userRoleOf(input);
  const password = String(input.password ?? input.pin ?? "");
  if (!password) throw new AppError("Enter password");
  const taken = findActive(ctx, username);
  if (taken) throw new AppError("Username already exists");
  const id = uuid();
  const profile = profileOf(input, userRole);
  ctx.db
    .prepare(
      `INSERT INTO staff (
         id, name, username, pin_hash, role, active, created_at,
         user_role, discount_pct, old_date_record, mis_report,
         hide_collection, hide_estimate, allow_complementary, advance_card_update, show_checkin_rooms,
         bill_flags, rights_json, outlet_rights
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, username, username, hashPin(password), profile.role, nowIso(), ...profileArgs(profile));
  audit(ctx, "STAFF_CREATE", "staff", id, null, null, { username, userRole });
  return mapStaff(ctx, ctx.db.prepare("SELECT * FROM staff WHERE id = ?").get(id) as StaffRow);
}

export function updateStaff(ctx: AppContext, id: string, input: StaffInput) {
  assertCanManageUsers(ctx);
  const existing = ctx.db.prepare("SELECT * FROM staff WHERE id = ? AND active = 1").get(id) as StaffRow | undefined;
  if (!existing) throw new AppError("User not found");
  const username = String(input.username ?? existing.username).trim();
  if (!username) throw new AppError("Enter username");
  const userRole = userRoleOf({ ...input, userRole: input.userRole ?? roleLabel(existing.role, existing.user_role) });
  if (username !== existing.username) {
    const taken = ctx.db
      .prepare("SELECT id FROM staff WHERE lower(username) = lower(?) AND active = 1 AND id <> ?")
      .get(username, id);
    if (taken) throw new AppError("Username already exists");
  }
  const password = String(input.password ?? input.pin ?? "");
  const profile = profileOf(input, userRole);
  ctx.db
    .prepare(
      `UPDATE staff SET name=?, username=?, role=?, ${PROFILE_SQL} WHERE id=?`,
    )
    .run(username, username, profile.role, ...profileArgs(profile), id);
  if (password) {
    ctx.db.prepare("UPDATE staff SET pin_hash = ? WHERE id = ?").run(hashPin(password), id);
  }
  audit(ctx, "STAFF_UPDATE", "staff", id, null, null, { username, userRole });
  return mapStaff(ctx, ctx.db.prepare("SELECT * FROM staff WHERE id = ?").get(id) as StaffRow);
}

export function deleteStaff(ctx: AppContext, id: string) {
  assertCanManageUsers(ctx);
  if (id === ctx.actor.staffId) throw new AppError("Cannot delete the logged in user");
  const existing = ctx.db.prepare("SELECT * FROM staff WHERE id = ? AND active = 1").get(id) as StaffRow | undefined;
  if (!existing) throw new AppError("User not found");
  const retired = `${existing.username}~${id.slice(0, 8)}`;
  ctx.db.prepare("UPDATE staff SET active = 0, username = ? WHERE id = ?").run(retired, id);
  audit(ctx, "STAFF_DELETE", "staff", id, null, { username: existing.username }, null);
  return { ok: true };
}

export function listProducts(ctx: AppContext) {
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.category_id, p.station, p.base_price, p.tax_rate,
              p.item_group, p.sales_group, p.track_inventory, p.unit, p.active, c.name AS category_name
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1
       ORDER BY p.station, p.name`,
    )
    .all() as Array<Record<string, unknown>>;
  const rates = deptRatesByProduct(ctx);
  return rows.map((p) => ({ ...p, dept_rates: rates[String(p.id)] ?? {} }));
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
