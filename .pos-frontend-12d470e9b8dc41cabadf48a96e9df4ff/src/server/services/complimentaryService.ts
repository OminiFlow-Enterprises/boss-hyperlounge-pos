import { AppError } from "../lib/errors.js";
import type { AppContext } from "../lib/context.js";
import { nowIso, uuid } from "../lib/ids.js";

export type ComplimentaryAccount = { id: string; code: number; name: string };

export function listComplimentary(ctx: AppContext): ComplimentaryAccount[] {
  return ctx.db
    .prepare("SELECT id, code, name FROM complimentary_accounts ORDER BY code, name")
    .all() as ComplimentaryAccount[];
}

export function createComplimentary(ctx: AppContext, name: string): ComplimentaryAccount {
  const clean = String(name ?? "").trim();
  if (!clean) throw new AppError("Name is required");
  const next = (
    ctx.db.prepare("SELECT COALESCE(MAX(code), 0) + 1 AS code FROM complimentary_accounts").get() as { code: number }
  ).code;
  const id = uuid();
  ctx.db
    .prepare("INSERT INTO complimentary_accounts (id, code, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, next, clean, nowIso());
  return { id, code: next, name: clean };
}

export function updateComplimentary(ctx: AppContext, id: string, name: string): ComplimentaryAccount {
  const clean = String(name ?? "").trim();
  if (!clean) throw new AppError("Name is required");
  const row = ctx.db.prepare("SELECT id FROM complimentary_accounts WHERE id = ?").get(id);
  if (!row) throw new AppError("Complimentary account not found", 404);
  ctx.db.prepare("UPDATE complimentary_accounts SET name = ? WHERE id = ?").run(clean, id);
  return ctx.db.prepare("SELECT id, code, name FROM complimentary_accounts WHERE id = ?").get(id) as ComplimentaryAccount;
}

export function deleteComplimentary(ctx: AppContext, id: string) {
  const row = ctx.db.prepare("SELECT id FROM complimentary_accounts WHERE id = ?").get(id);
  if (!row) throw new AppError("Complimentary account not found", 404);
  ctx.db.prepare("DELETE FROM complimentary_accounts WHERE id = ?").run(id);
  return { ok: true };
}
