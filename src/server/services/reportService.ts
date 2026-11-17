import { assertPermission } from "../../shared/permissions.js";
import type { AppContext } from "../lib/context.js";
import { AppError } from "../lib/errors.js";
import { nowIso, todayDate, uuid } from "../lib/ids.js";
import { audit } from "../lib/audit.js";
import * as cards from "./cardService.js";

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

function dateRange(from?: string, to?: string) {
  const start = from || todayDate();
  const end = to || start;
  return { from: `${start}T00:00:00.000Z`, to: `${end}T23:59:59.999Z`, start, end };
}

export function itemWiseSales(ctx: AppContext, from?: string, to?: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  const rows = ctx.db
    .prepare(
      `SELECT ii.name AS item_name, i.invoice_number AS bill_no, t.code AS table_no,
              k.kot_number AS kot, COALESCE(k.created_at, i.created_at) AS kot_at,
              ii.qty AS qty, ii.amount AS amount, ii.station AS station,
              COALESCE(p.tax_rate, 0) AS tax_rate, i.status AS bill_status
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN products p ON p.id = ii.product_id
       LEFT JOIN order_items oi ON oi.id = ii.order_item_id
       LEFT JOIN kots k ON k.id = oi.kot_id
       WHERE i.created_at BETWEEN ? AND ?
       ORDER BY ii.station, ii.name, i.created_at`,
    )
    .all(range.from, range.to);
  return { from: range.start, to: range.end, rows };
}

export function gstSummary(ctx: AppContext, from?: string, to?: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  const inv = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(grand_total),0) AS total, COALESCE(SUM(discount),0) AS discount,
              COALESCE(SUM(service_charge),0) AS service, COALESCE(SUM(tax),0) AS tax,
              COALESCE(SUM(food_total),0) AS food, COALESCE(SUM(drinks_total),0) AS drinks,
              COUNT(*) AS bills
       FROM invoices WHERE created_at BETWEEN ? AND ? AND status IN ('PAID','UNPAID','PARTIAL')`,
    )
    .get(range.from, range.to) as Record<string, number>;
  const mop = ctx.db
    .prepare(
      `SELECT p.method AS method, COALESCE(SUM(p.amount),0) AS amount
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE p.created_at BETWEEN ? AND ?
       GROUP BY p.method`,
    )
    .all(range.from, range.to) as Array<{ method: string; amount: number }>;
  return { from: range.start, to: range.end, ...inv, mop };
}

export function settlementReport(
  ctx: AppContext,
  from?: string,
  to?: string,
  outlet?: string,
  filters?: { mop?: string; billNo?: string; account?: string; user?: string; settledOnly?: boolean },
) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  const where = ["p.created_at BETWEEN ? AND ?"];
  const args: Array<string | number> = [range.from, range.to];
  if (outlet) {
    where.push("COALESCE(t.outlet, 'BAR') = ?");
    args.push(outlet);
  }
  const mop = filters?.mop && filters.mop !== "Select" ? filters.mop : "";
  if (mop === "CASH") where.push("p.method = 'CASH'");
  else if (mop === "PREPAID CARD") where.push("p.method = 'MEMBER_CARD'");
  else if (mop === "BANK TRANSFER") where.push("p.method IN ('CARD','UPI')");
  if (filters?.billNo?.trim()) {
    where.push("i.invoice_number LIKE ?");
    args.push(`%${filters.billNo.trim()}%`);
  }
  if (filters?.account && filters.account !== "Select") {
    where.push("COALESCE(p.reference, '') = ?");
    args.push(filters.account);
  }
  if (filters?.user && filters.user !== "Select") {
    where.push("s.name = ?");
    args.push(filters.user);
  }
  if (filters?.settledOnly) where.push("i.status = 'PAID'");
  const rows = ctx.db
    .prepare(
      `SELECT p.id AS payment_id, p.receipt_no, p.voucher_no, p.remark,
              i.id AS invoice_id, i.invoice_number AS bill_no, i.grand_total AS bill_amount,
              COALESCE(NULLIF(t.name, ''), t.code) AS table_no,
              p.created_at AS voucher_date, p.amount AS settled, i.status, i.discount AS allowance,
              p.method AS method, COALESCE(p.reference, '') AS account,
              s.name AS username, w.name AS waiter, cu.name AS guest,
              COALESCE(t.outlet, 'BAR') AS outlet_name
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN staff s ON s.id = i.cashier_id
       LEFT JOIN customers cu ON cu.id = i.customer_id
       LEFT JOIN table_sessions ts ON ts.id = i.session_id
       LEFT JOIN staff w ON w.id = ts.waiter_id
       WHERE ${where.join(" AND ")}
       ORDER BY p.created_at, i.invoice_number`,
    )
    .all(...args) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  let allowance = 0;
  const totals = { CASH: 0, CARD: 0, UPI: 0, MEMBER_CARD: 0 };
  for (const row of rows) {
    const method = String(row.method || "");
    const amount = Number(row.settled) || 0;
    if (method === "CASH") totals.CASH += amount;
    else if (method === "MEMBER_CARD") totals.MEMBER_CARD += amount;
    else if (method === "UPI") totals.UPI += amount;
    else totals.CARD += amount;
    const id = String(row.invoice_id || "");
    if (id && !seen.has(id)) {
      seen.add(id);
      allowance += Number(row.allowance) || 0;
    }
  }
  const users = ctx.db
    .prepare(`SELECT name FROM staff WHERE active = 1 ORDER BY name`)
    .all() as Array<{ name: string }>;
  return {
    from: range.start,
    to: range.end,
    outlet: outlet || "THE BOSS CLUB",
    rows,
    totals: [
      { method: "CASH", amount: totals.CASH },
      { method: "CARD", amount: totals.CARD },
      { method: "UPI", amount: totals.UPI },
      { method: "MEMBER_CARD", amount: totals.MEMBER_CARD },
    ],
    allowance,
    users: users.map((u) => u.name),
  };
}

function settlementRow(ctx: AppContext, paymentId: string) {
  return ctx.db
    .prepare(
      `SELECT p.id AS payment_id, p.receipt_no, p.voucher_no, COALESCE(p.remark, '') AS remark,
              p.method, p.amount, COALESCE(p.reference, '') AS account, p.created_at AS voucher_date,
              p.member_card_id, p.ledger_id,
              i.id AS invoice_id, i.invoice_number AS bill_no, i.grand_total AS bill_amount,
              i.discount AS allowance, i.status, i.order_id,
              COALESCE(NULLIF(t.name, ''), t.code) AS table_no,
              COALESCE(t.outlet, 'BAR') AS outlet_name,
              cu.name AS guest,
              (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = i.id) AS paid
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN customers cu ON cu.id = i.customer_id
       WHERE p.id = ?`,
    )
    .get(paymentId) as Record<string, unknown> | undefined;
}

export function settlementDetail(ctx: AppContext, paymentId: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const row = settlementRow(ctx, paymentId);
  if (!row) throw new AppError("Settlement not found", 404);
  return row;
}

function applyPaidStatus(ctx: AppContext, invoiceId: string, orderId: string, grand: number, paid: number) {
  if (paid >= grand && grand > 0) {
    ctx.db.prepare("UPDATE invoices SET status = 'PAID', paid_at = COALESCE(paid_at, ?) WHERE id = ?").run(nowIso(), invoiceId);
    ctx.db.prepare("UPDATE orders SET status = 'PAID' WHERE id = ?").run(orderId);
    return;
  }
  ctx.db.prepare("UPDATE invoices SET status = ?, paid_at = NULL WHERE id = ?").run(paid > 0 ? "PARTIAL" : "UNPAID", invoiceId);
  ctx.db.prepare("UPDATE orders SET status = 'SETTLING' WHERE id = ? AND status = 'PAID'").run(orderId);
}

export function updateSettlement(
  ctx: AppContext,
  paymentId: string,
  input: { method?: string; amount?: number; account?: string; remark?: string },
) {
  assertPermission(ctx.actor.role, "SETTLE_BILL");
  const mode = String(input.method || "CASH");
  const method = mode === "BANK TRANSFER" ? "CARD" : mode === "PREPAID CARD" ? "MEMBER_CARD" : mode === "CASH" ? "CASH" : "";
  if (!method) throw new AppError("Select payment mode");
  const amount = Number(input.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError("Enter settle amount");
  const account = String(input.account || "").trim();
  if (method === "CARD" && (!account || account === "Select" || account === "Cash.")) throw new AppError("Select bank name");
  const remark = String(input.remark ?? "").trim();
  if (!remark) throw new AppError("Enter Remark");

  return ctx.db.transaction(() => {
    const row = settlementRow(ctx, paymentId);
    if (!row) throw new AppError("Settlement not found", 404);
    const current = String(row.method || "");
    if (current === "MEMBER_CARD" && (method !== "MEMBER_CARD" || amount !== Number(row.amount))) {
      throw new AppError("Prepaid card settlement cannot be changed");
    }
    if (method === "MEMBER_CARD" && current !== "MEMBER_CARD") {
      throw new AppError("Prepaid card settlement cannot be added here");
    }
    const others = Number(row.paid) - Number(row.amount);
    if (others + amount > Number(row.bill_amount)) throw new AppError("Amount exceeds bill");
    const storedAccount = method === "CASH" ? (account || "Cash.") : method === "CARD" ? account : String(row.account || "");
    ctx.db
      .prepare("UPDATE payments SET method = ?, amount = ?, reference = ?, remark = ? WHERE id = ?")
      .run(method, amount, storedAccount, remark, paymentId);
    applyPaidStatus(ctx, String(row.invoice_id), String(row.order_id), Number(row.bill_amount), others + amount);
    audit(ctx, "SETTLEMENT_UPDATE", "payment", paymentId, null, row.amount, { method, amount, account: storedAccount });
    return settlementRow(ctx, paymentId);
  })();
}

export function deleteSettlement(ctx: AppContext, paymentId: string) {
  assertPermission(ctx.actor.role, "SETTLE_BILL");
  return ctx.db.transaction(() => {
    const row = settlementRow(ctx, paymentId);
    if (!row) throw new AppError("Settlement not found", 404);
    if (String(row.method) === "MEMBER_CARD" && row.ledger_id) {
      throw new AppError("Prepaid card settlement cannot be deleted here");
    }
    ctx.db.prepare("DELETE FROM payments WHERE id = ?").run(paymentId);
    const paid = Number(row.paid) - Number(row.amount);
    applyPaidStatus(ctx, String(row.invoice_id), String(row.order_id), Number(row.bill_amount), paid);
    audit(ctx, "SETTLEMENT_DELETE", "payment", paymentId, null, row.amount, row.bill_no);
    return { ok: true };
  })();
}

export function kotReport(ctx: AppContext, from?: string, to?: string, station?: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  let sql = `SELECT k.kot_number, t.code AS table_no, k.station, k.status, k.created_at,
                    k.type, GROUP_CONCAT(ki.qty || ' x ' || ki.name, ', ') AS items
             FROM kots k
             JOIN dining_tables t ON t.id = k.table_id
             LEFT JOIN kot_items ki ON ki.kot_id = k.id
             WHERE k.created_at BETWEEN ? AND ?`;
  const args: string[] = [range.from, range.to];
  if (station) {
    sql += " AND k.station = ?";
    args.push(station);
  }
  sql += " GROUP BY k.id ORDER BY k.created_at";
  return { from: range.start, to: range.end, rows: ctx.db.prepare(sql).all(...args) };
}

export function billReport(ctx: AppContext, from?: string, to?: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  const rows = ctx.db
    .prepare(
      `SELECT i.invoice_number, COALESCE(NULLIF(t.name, ''), t.code) AS table_no, i.grand_total, i.status, i.created_at,
              i.food_total, i.drinks_total, cu.name AS guest,
              COALESCE(NULLIF(t.outlet, ''), 'BAR') AS outlet_name,
              (SELECT p.id FROM payments p WHERE p.invoice_id = i.id ORDER BY p.created_at DESC LIMIT 1) AS payment_id
       FROM invoices i
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN customers cu ON cu.id = i.customer_id
       WHERE i.created_at BETWEEN ? AND ?
       ORDER BY i.created_at`,
    )
    .all(range.from, range.to);
  return { from: range.start, to: range.end, rows };
}

export function listBookings(ctx: AppContext) {
  return ctx.db.prepare("SELECT * FROM bookings ORDER BY created_at DESC").all();
}

export function saveBooking(
  ctx: AppContext,
  body: { mobile?: string; guestName?: string; cardNo?: string; advance?: number; outlet?: string; mop?: string },
) {
  const max = ctx.db.prepare("SELECT COALESCE(MAX(reservation_no), 429) AS n FROM bookings").get() as { n: number };
  const id = uuid();
  const no = max.n + 1;
  const cardNo = (body.cardNo ?? "").trim();
  const advance = body.advance ?? 0;
  if (!/^\d{4}$/.test(cardNo)) throw new AppError("Card No must be 4 digits");
  if (!(advance > 10000)) throw new AppError("Advance must be greater than 100.00");
  ctx.db
    .prepare(
      `INSERT INTO bookings (id, reservation_no, mobile, guest_name, card_no, advance, outlet, mop, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, no, body.mobile ?? "", body.guestName ?? "", cardNo, advance, body.outlet ?? "THE BOSS CLUB", body.mop ?? "", nowIso());
  let card = null;
  if (cardNo && advance > 0) {
    card = cards.ensureCardAndCreditAdvance(ctx, {
      cardNumber: cardNo,
      guestName: body.guestName,
      mobile: body.mobile,
      amount: advance,
      paymentMode: body.mop,
      idempotencyKey: `adv:${id}`,
    });
  }
  const booking = ctx.db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
  return { ...booking as object, card, balances: card ? cards.balancesFromLedger(ctx, card.id) : { paid: 0, bonus: 0, usable: 0 } };
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
