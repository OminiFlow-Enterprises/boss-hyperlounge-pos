import { uuid, nowIso } from "./ids.js";
import type { AppContext } from "./context.js";

export function audit(
  ctx: AppContext,
  action: string,
  entityType: string,
  entityId: string | null,
  reason: string | null,
  oldValue: unknown,
  newValue: unknown,
): void {
  ctx.db
    .prepare(
      `INSERT INTO audit_log
        (id, action, entity_type, entity_id, user_id, user_name, terminal_id, old_value, new_value, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uuid(),
      action,
      entityType,
      entityId,
      ctx.actor.staffId,
      ctx.actor.staffName,
      ctx.actor.terminalId,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      reason,
      nowIso(),
    );
}

export function enqueueSync(
  ctx: AppContext,
  entityType: string,
  entityId: string,
  payload: unknown,
  idempotencyKey: string,
): void {
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO sync_queue
        (id, idempotency_key, entity_type, entity_id, payload, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?)`,
    )
    .run(uuid(), idempotencyKey, entityType, entityId, JSON.stringify(payload), nowIso());
}
