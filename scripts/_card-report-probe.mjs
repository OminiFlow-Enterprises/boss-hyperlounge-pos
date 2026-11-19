import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const db = new DatabaseSync("data/hyperlounge.sqlite", { readOnly: true });
const sql = `
WITH seq AS (
  SELECT id, card_no, guest_name, advance, created_at,
         LEAD(created_at) OVER (PARTITION BY card_no ORDER BY created_at, id) AS next_at
  FROM bookings
  WHERE card_no != '' AND (? = '' OR card_no = ?)
)
SELECT b.id AS booking_id, b.card_no,
       CASE WHEN TRIM(COALESCE(b.guest_name, '')) != '' THEN TRIM(b.guest_name) ELSE COALESCE(cu.name, '') END AS guest_name,
       b.created_at AS booking_date, b.advance AS card_balance,
       MAX(0, COALESCE((
         SELECT l.new_paid + l.new_bonus FROM card_ledger l
         WHERE l.card_id = mc.id AND l.created_at >= b.created_at
           AND l.created_at < COALESCE(b.next_at, '9999-12-31T23:59:59.999Z')
         ORDER BY l.created_at DESC LIMIT 1
       ), CASE WHEN b.next_at IS NULL THEN COALESCE(mc.paid_balance, 0) + COALESCE(mc.bonus_balance, 0) ELSE 0 END)) AS remaining_balance
FROM seq b
LEFT JOIN member_cards mc ON mc.card_number = b.card_no
LEFT JOIN customers cu ON cu.id = mc.customer_id
WHERE b.created_at BETWEEN ? AND ?
ORDER BY b.created_at, b.card_no, b.id`;
const stmt = db.prepare(sql);
const t0 = performance.now();
const all = stmt.all("", "", "2020-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z");
console.log("all", all.length, "ms", (performance.now() - t0).toFixed(1));
const t1 = performance.now();
const day = stmt.all("", "", "2026-11-19T00:00:00.000Z", "2026-11-19T23:59:59.999Z");
console.log("day ms", (performance.now() - t1).toFixed(1), JSON.stringify(day));
const one = day.find((r) => r.card_no === "1001");
console.log("1001 remaining paise", one?.remaining_balance, "expected 35100");
console.log(db.prepare("EXPLAIN QUERY PLAN " + sql).all("", "", "2026-11-19T00:00:00.000Z", "2026-11-19T23:59:59.999Z").map((r) => r.detail).join("\n"));
