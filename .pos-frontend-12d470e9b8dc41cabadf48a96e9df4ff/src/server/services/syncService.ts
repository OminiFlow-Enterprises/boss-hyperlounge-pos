import type { AppContext } from "../lib/context.js";
import { nowIso } from "../lib/ids.js";

export interface CloudSink {
  push(item: { idempotency_key: string; entity_type: string; entity_id: string; payload: string }): Promise<
    "ok" | "duplicate"
  >;
}

export class MemoryCloudSink implements CloudSink {
  seen = new Set<string>();
  items: Array<{ idempotency_key: string; entity_type: string; payload: string }> = [];
  failNext = false;

  async push(item: { idempotency_key: string; entity_type: string; entity_id: string; payload: string }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Cloud unreachable");
    }
    if (this.seen.has(item.idempotency_key)) return "duplicate";
    this.seen.add(item.idempotency_key);
    this.items.push(item);
    return "ok";
  }
}

let defaultSink: CloudSink = new MemoryCloudSink();

export function setCloudSink(sink: CloudSink) {
  defaultSink = sink;
}

export function getCloudSink() {
  return defaultSink;
}

export function syncStatus(ctx: AppContext) {
  const rows = ctx.db
    .prepare("SELECT status, COUNT(*) AS n FROM sync_queue GROUP BY status")
    .all() as Array<{ status: string; n: number }>;
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    online: ctx.online,
    pending: counts.PENDING ?? 0,
    failed: counts.FAILED ?? 0,
    synced: counts.SYNCED ?? 0,
  };
}

export async function flushSync(ctx: AppContext, sink: CloudSink = defaultSink) {
  const pending = ctx.db
    .prepare("SELECT * FROM sync_queue WHERE status IN ('PENDING','FAILED') ORDER BY created_at")
    .all() as Array<{
    id: string;
    idempotency_key: string;
    entity_type: string;
    entity_id: string;
    payload: string;
    attempts: number;
  }>;

  let synced = 0;
  let failed = 0;
  for (const item of pending) {
    ctx.db.prepare("UPDATE sync_queue SET status='SYNCING', attempts = attempts + 1 WHERE id = ?").run(item.id);
    try {
      const result = await sink.push(item);
      ctx.db
        .prepare("UPDATE sync_queue SET status='SYNCED', synced_at = ?, last_error = NULL WHERE id = ?")
        .run(nowIso(), item.id);
      synced += 1;
      void result;
    } catch (err) {
      ctx.db
        .prepare("UPDATE sync_queue SET status='FAILED', last_error = ? WHERE id = ?")
        .run(err instanceof Error ? err.message : "sync failed", item.id);
      failed += 1;
    }
  }
  return { synced, failed, remaining: pending.length - synced };
}
