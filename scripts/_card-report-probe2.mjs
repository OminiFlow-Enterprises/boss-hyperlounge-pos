import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/hyperlounge.sqlite", { readOnly: true });
function q(label, sql) {
  console.log("\n==", label);
  console.log(JSON.stringify(db.prepare(sql).all(), null, 2).slice(0, 4000));
}
q("invoice card_id", `
  SELECT COUNT(*) n,
    SUM(CASE WHEN card_id IS NOT NULL AND card_id != '' THEN 1 ELSE 0 END) with_card
  FROM invoices
`);
q("card 1001 bookings and pays", `
  SELECT 'booking' kind, card_no, guest_name, advance amount, created_at, '' invoice
  FROM bookings WHERE card_no = '1001'
  UNION ALL
  SELECT 'pay', mc.card_number, '', p.amount, p.created_at, i.invoice_number
  FROM payments p
  JOIN member_cards mc ON mc.id = p.member_card_id
  JOIN invoices i ON i.id = p.invoice_id
  WHERE mc.card_number = '1001'
  ORDER BY created_at
`);
q("ledger 1001", `
  SELECT l.type, l.direction, l.paid_amount, l.bonus_amount, l.new_paid, l.new_bonus, l.created_at, l.related_invoice_id
  FROM card_ledger l JOIN member_cards c ON c.id = l.card_id
  WHERE c.card_number = '1001' ORDER BY l.created_at
`);
q("payments method mix", "SELECT method, COUNT(*) n FROM payments GROUP BY method ORDER BY n DESC");
