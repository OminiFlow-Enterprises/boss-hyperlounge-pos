import type { AppContext } from "../lib/context.js";
import type { ServiceChargeMode } from "../../shared/types.js";
import { BILL_VENUE_DEFAULTS, type BillVenueInfo } from "../hardware/types.js";

const VENUE_KEYS: Record<keyof BillVenueInfo, string> = {
  name: "venue_name",
  unit: "venue_unit",
  address1: "venue_address1",
  address2: "venue_address2",
  address3: "venue_address3",
  contact: "venue_contact",
  gstin: "venue_gstin",
  hsn: "venue_hsn",
  tin: "venue_tin",
  footer: "venue_footer",
};

export function getSetting(ctx: AppContext, key: string, fallback = ""): string {
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(ctx: AppContext, key: string, value: string): void {
  ctx.db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function getAllSettings(ctx: AppContext): Record<string, string> {
  const rows = ctx.db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Fill missing venue keys once; do not overwrite values the site already set. */
export function ensureVenueSettings(ctx: AppContext): void {
  for (const [field, key] of Object.entries(VENUE_KEYS) as Array<[keyof BillVenueInfo, string]>) {
    const def = BILL_VENUE_DEFAULTS[field] ?? "";
    if (!getSetting(ctx, key) && def) setSetting(ctx, key, def);
  }
  if (getSetting(ctx, "venue_name") === "BOSS Hyperlounge") {
    setSetting(ctx, "venue_name", BILL_VENUE_DEFAULTS.name);
  }
  const footer = getSetting(ctx, "venue_footer");
  if (footer.endsWith("**.")) {
    setSetting(ctx, "venue_footer", BILL_VENUE_DEFAULTS.footer ?? footer);
  }
}

export function getVenueProfile(ctx: AppContext): BillVenueInfo {
  ensureVenueSettings(ctx);
  return {
    name: getSetting(ctx, VENUE_KEYS.name, BILL_VENUE_DEFAULTS.name),
    unit: getSetting(ctx, VENUE_KEYS.unit, BILL_VENUE_DEFAULTS.unit),
    address1: getSetting(ctx, VENUE_KEYS.address1, BILL_VENUE_DEFAULTS.address1),
    address2: getSetting(ctx, VENUE_KEYS.address2, BILL_VENUE_DEFAULTS.address2),
    address3: getSetting(ctx, VENUE_KEYS.address3, BILL_VENUE_DEFAULTS.address3),
    contact: getSetting(ctx, VENUE_KEYS.contact, BILL_VENUE_DEFAULTS.contact),
    gstin: getSetting(ctx, VENUE_KEYS.gstin, BILL_VENUE_DEFAULTS.gstin),
    hsn: getSetting(ctx, VENUE_KEYS.hsn, BILL_VENUE_DEFAULTS.hsn),
    tin: getSetting(ctx, VENUE_KEYS.tin, BILL_VENUE_DEFAULTS.tin),
    footer: getSetting(ctx, VENUE_KEYS.footer, BILL_VENUE_DEFAULTS.footer ?? ""),
  };
}

export function getServiceCharge(ctx: AppContext): { pct: number; mode: ServiceChargeMode } {
  const pct = Number(getSetting(ctx, "service_charge_pct", "10"));
  const mode = getSetting(ctx, "service_charge_mode", "EXCLUSIVE") as ServiceChargeMode;
  return { pct: Number.isFinite(pct) ? pct : 0, mode: mode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE" };
}

export function spendBonusFirst(ctx: AppContext): boolean {
  return getSetting(ctx, "spend_bonus_first", "1") === "1";
}

export function dayCloseHour(ctx: AppContext): number {
  const n = Number(getSetting(ctx, "day_close_hour", "6"));
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 6;
}
