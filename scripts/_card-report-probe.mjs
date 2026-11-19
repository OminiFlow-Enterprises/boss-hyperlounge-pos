import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const db = new DatabaseSync("data/hyperlounge.sqlite", { readOnly: true });
const sql = `
SELECT b.id AS booking_id, b.card_no,
       CASE WHEN TRIM(COALESCE(b.guest_name, '')) != '' THEN TRIM(b.guest_name) ELSE COALESCE(cu.name, '') END AS guest_name,
       b.created_at AS booking_date,
       b.advance AS card_balance,
       MAX(0, COALESCE((
         SELECT l.new_paid + l.new_bonus
         FROM card_ledger l
         WHERE l.card_id = mc.id
           AND l.created_at >= b.created_at
           AND l.created_at < COALESCE((
             SELECT b2.created_at FROM bookings b2
             WHERE b2.card_no = b.card_no
               AND (b2.created_at > b.created_at OR (b2.created_at = b.created_at AND b2.id > b.id))
             ORDER BY b2.created_at, b2.id
             LIMIT 1
           ), '9999-12-31T23:59:59.999Z')
         ORDER BY l.created_at DESC
         LIMIT 1
       ), CASE WHEN EXISTS (
            SELECT 1 FROM bookings b3
            WHERE b3.card_no = b.card_no
              AND (b3.created_at > b.created_at OR (b3.created_at = b.created_at AND b3.id > b.id))
          ) THEN 0
          ELSE COALESCE(mc.paid_balance, 0) + COALESCE(mc.bonus_balance, 0) END)) AS remaining_balance
FROM bookings b
LEFT JOIN member_cards mc ON mc.card_number = b.card_no
LEFT JOIN customers cu ON cu.id = mc.customer_id
WHERE b.created_at BETWEEN ? AND ? AND b.card_no != ''
ORDER BY b.created_at, b.card_no, b.id`;

const stmt = db.prepare(sql);
const t0 = performance.now();
const all = stmt.all("2020-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z");
const t1 = performance.now();
console.log("all rows", all.length, "ms", (t1 - t0).toFixed(1));
const day = stmt.all("2026-11-19T00:00:00.000Z", "2026-11-19T23:59:59.999Z");
console.log("today", JSON.stringify(day, null, 2));
const card = db.prepare(sql.replace("b.card_no != ''", "b.card_no != '' AND b.card_no = ?"));
const t2 = performance.now();
const one = card.all("2026-11-14T00:00:00.000Z", "2026-11-14T23:59:59.999Z", "2214");
console.log("2214 day ms", (performance.now() - t2).toFixed(1), JSON.stringify(one));

const latest = day.find((r) => r.card_no === "1001");
if (latest) {
  const booking = db.prepare(`
    SELECT b.id, b.card_no, b.created_at,
           (SELECT b2.created_at FROM bookings b2
            WHERE b2.card_no = b.card_no
              AND (b2.created_at > b.created_at OR (b2.created_at = b.created_at AND b2.id > b.id))
            ORDER BY b2.created_at, b2.id LIMIT 1) AS next_at
    FROM bookings b WHERE b.id = ?`).get(latest.booking_id);
  const mc = db.prepare("SELECT id FROM member_cards WHERE card_number = ?").get(booking.card_no);
  const next = booking.next_at || "9999-12-31T23:59:59.999Z";
  const bills = db.prepare(`
    SELECT i.id AS invoice_id, MIN(i.invoice_number) AS invoice_number,
           MIN(COALESCE(NULLIF(t.name, ''), t.code)) AS table_no,
           MIN(COALESCE(NULLIF(t.outlet, ''), 'BAR')) AS outlet,
           SUM(p.amount) AS amount
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    JOIN dining_tables t ON t.id = i.table_id
    WHERE p.method = 'MEMBER_CARD' AND p.member_card_id = ?
      AND p.created_at >= ? AND p.created_at < ?
    GROUP BY i.id
    ORDER BY MIN(p.created_at), invoice_number`).all(mc.id, booking.created_at, next);
  console.log("bills", JSON.stringify({ booking, bills }, null, 2));
}
console.log(db.prepare("EXPLAIN QUERY PLAN " + sql).all("2026-11-19T00:00:00.000Z", "2026-11-19T23:59:59.999Z").map((r) => r.detail).join("\n"));
