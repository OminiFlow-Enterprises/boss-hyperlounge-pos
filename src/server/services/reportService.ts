import { assertPermission } from "../../shared/permissions.js";
import type { AppContext } from "../lib/context.js";
import { nowIso, todayDate, uuid } from "../lib/ids.js";
import { audit } from "../lib/audit.js";

function dayRange(date = todayDate()) {
  return { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z` };
}

export function ownerDashboard(ctx: AppContext, date = todayDate()) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const { from, to } = dayRange(date);

  const recharge = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(paid_amount),0) AS n FROM card_ledger WHERE type='RECHARGE' AND created_at BETWEEN ? AND ?",
    )
    .get(from, to) as { n: number };
  const cardSales = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(paid_amount + bonus_amount),0) AS n FROM card_ledger WHERE type='PURCHASE' AND created_at BETWEEN ? AND ?",
    )
    .get(from, to) as { n: number };
  const refunds = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(paid_amount + bonus_amount),0) AS n FROM card_ledger WHERE type='REFUND' AND created_at BETWEEN ? AND ?",
    )
    .get(from, to) as { n: number };
  const bonus = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(bonus_amount),0) AS n FROM card_ledger WHERE type='BONUS' AND direction='CREDIT' AND created_at BETWEEN ? AND ?",
    )
    .get(from, to) as { n: number };
  const outstanding = ctx.db
    .prepare("SELECT COALESCE(SUM(paid_balance),0) AS paid, COALESCE(SUM(bonus_balance),0) AS bonus FROM member_cards")
    .get() as { paid: number; bonus: number };
  const swaps = ctx.db.prepare("SELECT COUNT(*) AS n FROM card_swaps WHERE created_at BETWEEN ? AND ?").get(from, to) as {
    n: number;
  };
  const blocked = ctx.db.prepare("SELECT COUNT(*) AS n FROM member_cards WHERE status IN ('BLOCKED','LOST')").get() as {
    n: number;
  };
  const active = ctx.db.prepare("SELECT COUNT(*) AS n FROM member_cards WHERE status = 'ACTIVE'").get() as { n: number };
  const sales = ctx.db
    .prepare("SELECT COALESCE(SUM(grand_total),0) AS n FROM invoices WHERE status='PAID' AND created_at BETWEEN ? AND ?")
    .get(from, to) as { n: number };

  return {
    date,
    todayRecharge: recharge.n,
    cardSales: cardSales.n,
    cardUsage: cardSales.n,
    outstandingPaid: outstanding.paid,
    outstandingBonus: outstanding.bonus,
    outstandingTotal: outstanding.paid + outstanding.bonus,
    bonusIssued: bonus.n,
    refunds: refunds.n,
    cardSwaps: swaps.n,
    blockedCards: blocked.n,
    activeCards: active.n,
    invoiceSales: sales.n,
  };
}

export function reconcile(ctx: AppContext, date = todayDate()) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const { from, to } = dayRange(date);

  const opening = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE WHEN direction='CREDIT' THEN paid_amount + bonus_amount ELSE -(paid_amount + bonus_amount) END
       ),0) AS n
       FROM card_ledger WHERE created_at < ?`,
    )
    .get(from) as { n: number };

  const recharges = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(paid_amount),0) AS n FROM card_ledger WHERE type='RECHARGE' AND created_at BETWEEN ? AND ?",
    )
    .get(from, to) as { n: number };
  const bonuses = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(bonus_amount),0) AS n FROM card_ledger WHERE type='BONUS' AND direction='CREDIT' AND created_at BETWEEN ? AND ?",
    )
    .get(from, to) as { n: number };
  const purchases = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(paid_amount + bonus_amount),0) AS n FROM card_ledger WHERE type='PURCHASE' AND created_at BETWEEN ? AND ?",
    )
    .get(from, to) as { n: number };
  const refunds = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(paid_amount + bonus_amount),0) AS n FROM card_ledger WHERE type='REFUND' AND created_at BETWEEN ? AND ?",
    )
    .get(from, to) as { n: number };
  const adjustments = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN paid_amount + bonus_amount ELSE -(paid_amount + bonus_amount) END),0) AS n
       FROM card_ledger WHERE type IN ('ADJUSTMENT','EXPIRY','REVERSAL','TRANSFER') AND created_at BETWEEN ? AND ?`,
    )
    .get(from, to) as { n: number };

  const expected = opening.n + recharges.n + bonuses.n - purchases.n + refunds.n + adjustments.n;
  const actual = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE WHEN direction='CREDIT' THEN paid_amount + bonus_amount ELSE -(paid_amount + bonus_amount) END
       ),0) AS n
       FROM card_ledger WHERE created_at <= ?`,
    )
    .get(to) as { n: number };

  return {
    date,
    openingLiability: opening.n,
    recharges: recharges.n,
    bonuses: bonuses.n,
    purchases: purchases.n,
    refunds: refunds.n,
    adjustments: adjustments.n,
    expectedClosing: expected,
    actualClosing: actual.n,
    difference: actual.n - expected,
  };
}

export function dayClose(ctx: AppContext, date = todayDate()) {
  assertPermission(ctx.actor.role, "DAY_CLOSE");
  const rec = reconcile(ctx, date);
  const existing = ctx.db.prepare("SELECT id FROM day_closes WHERE business_date = ?").get(date);
  if (existing) throw new Error("Day already closed");
  const id = uuid();
  ctx.db
    .prepare(
      `INSERT INTO day_closes
        (id, business_date, opening_liability, recharges, bonuses, purchases, refunds, adjustments,
         expected_closing, actual_closing, difference, staff_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      date,
      rec.openingLiability,
      rec.recharges,
      rec.bonuses,
      rec.purchases,
      rec.refunds,
      rec.adjustments,
      rec.expectedClosing,
      rec.actualClosing,
      rec.difference,
      ctx.actor.staffId,
      nowIso(),
    );
  audit(ctx, "DAY_CLOSE", "day_close", id, date, null, rec);
  return { id, ...rec };
}

export function salesReport(ctx: AppContext, date = todayDate()) {
  const { from, to } = dayRange(date);
  const invoices = ctx.db
    .prepare("SELECT * FROM invoices WHERE status='PAID' AND created_at BETWEEN ? AND ?")
    .all(from, to);
  const byStation = ctx.db
    .prepare(
      `SELECT ii.station, SUM(ii.amount) AS amount
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.status='PAID' AND i.created_at BETWEEN ? AND ?
       GROUP BY ii.station`,
    )
    .all(from, to);
  return { date, invoices, byStation };
}

export function listAudit(ctx: AppContext, limit = 200) {
  return ctx.db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?").all(limit);
}
