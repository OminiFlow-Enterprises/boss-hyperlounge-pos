import type { AppContext } from "../lib/context.js";
import type { ServiceChargeMode } from "../../shared/types.js";

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

export function getServiceCharge(ctx: AppContext): { pct: number; mode: ServiceChargeMode } {
  const pct = Number(getSetting(ctx, "service_charge_pct", "5"));
  const mode = getSetting(ctx, "service_charge_mode", "EXCLUSIVE") as ServiceChargeMode;
  return { pct: Number.isFinite(pct) ? pct : 0, mode: mode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE" };
}

export function spendBonusFirst(ctx: AppContext): boolean {
  return getSetting(ctx, "spend_bonus_first", "1") === "1";
}
