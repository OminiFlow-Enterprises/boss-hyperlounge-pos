import { assertPermission } from "../../shared/permissions.js";
import { formatTableNo } from "../../shared/tableLabel.js";
import type { AppContext } from "../lib/context.js";
import { AppError } from "../lib/errors.js";
import { nextSequence, nowIso, todayDate, uuid } from "../lib/ids.js";
import { audit } from "../lib/audit.js";
import { buildBillTotalLines, type BillTotalLine } from "../hardware/billTotals.js";
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

const INVOICE_ORDER_CARD = `(
  SELECT c.card_number FROM member_cards c
   WHERE c.id = COALESCE(
     i.card_id,
     (SELECT o.card_id FROM orders o WHERE o.id = i.order_id),
     (SELECT s.card_id FROM table_sessions s WHERE s.id = i.session_id)
   )
)`;

const KOT_ORDER_CARD = `(
  SELECT c.card_number FROM member_cards c
   WHERE c.id = COALESCE(
     (SELECT o.card_id FROM orders o WHERE o.id = k.order_id),
     (SELECT s.card_id FROM table_sessions s WHERE s.id = k.session_id)
   )
)`;

function stampClubTable<T extends Record<string, unknown>>(row: T): T {
  const outlet = String(row.outlet_name ?? row.outlet ?? "");
  const code = String(row.table_code ?? "").trim();
  const card = String(row.order_card ?? "").trim();
  if (!code) return row;
  const label = formatTableNo(code, card, outlet);
  if (label === code) return row;
  return { ...row, table_label: label, table_no: label } as T;
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
              t.code AS table_code,
              COALESCE(NULLIF(t.outlet, ''), 'BAR') AS outlet_name,
              ${INVOICE_ORDER_CARD} AS order_card,
              k.kot_number AS kot, COALESCE(k.created_at, i.created_at) AS kot_at,
              i.created_at AS sale_at,
              ii.qty AS qty, ii.amount AS amount, ii.station AS station,
              COALESCE(p.tax_rate, oi.tax_rate, 0) AS tax_rate,
              COALESCE(p.sales_group, '') AS sales_group,
              COALESCE(p.item_group, '') AS item_group,
              COALESCE(p.unit, '') AS unit,
              COALESCE(w.name, '') AS waiter,
              COALESCE((SELECT GROUP_CONCAT(DISTINCT UPPER(pay.method)) FROM payments pay WHERE pay.invoice_id = i.id), '') AS mop,
              i.status AS bill_status
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN products p ON p.id = ii.product_id
       LEFT JOIN order_items oi ON oi.id = ii.order_item_id
       LEFT JOIN orders o ON o.id = i.order_id
       LEFT JOIN staff w ON w.id = o.waiter_id
       LEFT JOIN kots k ON k.id = oi.kot_id
       WHERE i.created_at BETWEEN ? AND ?
       ORDER BY ii.station, ii.name, i.created_at`,
    )
    .all(range.from, range.to) as Array<Record<string, unknown>>;
  return { from: range.start, to: range.end, rows: rows.map(stampClubTable) };
}

export function tableTransferReport(ctx: AppContext, from?: string, to?: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  return ctx.db.prepare(
    `SELECT tt.id, tt.created_at, f.code AS from_table, t.code AS to_table,
            tt.reason, COALESCE(s.name, '') AS staff_name
       FROM table_transfers tt
       LEFT JOIN dining_tables f ON f.id = tt.from_table_id
       LEFT JOIN dining_tables t ON t.id = tt.to_table_id
       LEFT JOIN staff s ON s.id = tt.staff_id
      WHERE tt.created_at BETWEEN ? AND ? ORDER BY tt.created_at DESC`,
  ).all(range.from, range.to);
}

export function itemTransferReport(ctx: AppContext, from?: string, to?: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  const rows = ctx.db.prepare(
    `SELECT id, entity_id, user_name, old_value, new_value, reason, created_at
       FROM audit_log WHERE action = 'ITEM_TRANSFER' AND created_at BETWEEN ? AND ?
       ORDER BY created_at DESC`,
  ).all(range.from, range.to) as Array<{ id: string; entity_id: string | null; user_name: string | null; old_value: string | null; new_value: string | null; reason: string | null; created_at: string }>;
  return rows.map((row) => {
    let transfer: { to?: string; itemIds?: string[] } = {};
    try { transfer = JSON.parse(row.new_value || "{}"); } catch { /* retain the audit record */ }
    const ids = Array.isArray(transfer.itemIds) ? transfer.itemIds : [];
    const names = ids.length
      ? ctx.db.prepare(`SELECT name FROM order_items WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ name: string }>
      : [];
    const source = ctx.db.prepare("SELECT code FROM dining_tables WHERE id = ?").get(row.entity_id) as { code: string } | undefined;
    return { id: row.id, created_at: row.created_at, from_table: source?.code || row.old_value || "", to_table: transfer.to || "", item_names: names.map((item) => item.name).join(", "), item_count: ids.length, reason: row.reason || "", staff_name: row.user_name || "" };
  });
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

function mopParticularLabel(method: string, account: string) {
  const m = String(method || "").toUpperCase();
  const acc = String(account || "").trim().toUpperCase();
  if (m === "CASH") return "CASH";
  if (m === "MEMBER_CARD") return "PREPAID CARD";
  if (m === "CARD" || m === "UPI") {
    // Native slip: "BANK TRANSFER / DINEOUT" (account on same / next line)
    return acc ? `BANK TRANSFER / ${acc}` : "BANK TRANSFER";
  }
  if (acc) return `${m || "OTHER"} / ${acc}`;
  return m || "OTHER";
}

/** Tax Summery Small Print — Crystal GST Summery slip + footer. */
export function gstTaxSummary(
  ctx: AppContext,
  from?: string,
  to?: string,
  filters?: { outlet?: string; billNo?: string; taxReport?: string },
) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const bill = gstBillWise(ctx, from, to, filters);
  const t = bill.totals;
  const gst18Tax = (Number(t.sgst_9) || 0) + (Number(t.cgst_9) || 0);
  const roundOff = Number(t.round_off) || 0;
  // Native Total Tax = GST + VAT + Surcharge + Round Off
  const totalTax =
    gst18Tax + (Number(t.vat_20) || 0) + (Number(t.surchar_20) || 0) + roundOff;
  const summary = {
    total: Number(t.amount) || 0,
    discount: Number(t.discount) || 0,
    s_total: Number(t.gross_amount) || 0,
    service: Number(t.service_charge) || 0,
    non_gst: 0,
    gst5_base: 0,
    gst5_tax: 0,
    gst18_base: Number(t.net_18) || 0,
    gst18_tax: gst18Tax,
    vat20_base: Number(t.net_20) || 0,
    vat20_tax: Number(t.vat_20) || 0,
    surcharge20_base: Number(t.net_surchar) || 0,
    surcharge20_tax: Number(t.surchar_20) || 0,
    round_off: roundOff,
    total_tax: totalTax,
    net_amount: Number(t.net_amount) || 0,
    bill_advance: Number(bill.footer?.advance) || 0,
  };

  const range = dateRange(from, to);
  const outlet = String(filters?.outlet || "").trim();
  const where = ["i.created_at BETWEEN ? AND ?", "i.status IN ('PAID','UNPAID','PARTIAL')"];
  const args: Array<string | number> = [range.from, range.to];
  if (outlet && outlet !== "Select") {
    where.push("COALESCE(NULLIF(t.outlet, ''), 'BAR') = ?");
    args.push(outlet);
  }

  const payRows = ctx.db
    .prepare(
      `SELECT p.method AS method, COALESCE(NULLIF(p.reference, ''), '') AS account,
              COALESCE(SUM(p.amount), 0) AS amount
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN dining_tables t ON t.id = i.table_id
       WHERE ${where.join(" AND ")}
       GROUP BY p.method, account
       ORDER BY p.method, account`,
    )
    .all(...args) as Array<{ method: string; account: string; amount: number }>;

  const particulars: Array<{ label: string; amount: number }> = [];
  const advanceRows = ctx.db
    .prepare(
      `SELECT COALESCE(NULLIF(mop, ''), 'CARD / PAYTM') AS mop, COALESCE(SUM(advance), 0) AS amount
       FROM bookings WHERE created_at BETWEEN ? AND ?
       GROUP BY mop HAVING amount > 0
       ORDER BY mop`,
    )
    .all(range.from, range.to) as Array<{ mop: string; amount: number }>;
  for (const a of advanceRows) {
    // Native: "Advance :CARD / PAYTM"
    const mop = String(a.mop || "CARD / PAYTM").trim();
    particulars.push({ label: `Advance :${mop}`, amount: Number(a.amount) || 0 });
  }
  for (const p of payRows) {
    const amt = Number(p.amount) || 0;
    if (!amt) continue;
    particulars.push({ label: mopParticularLabel(p.method, p.account), amount: amt });
  }

  return {
    from: bill.from,
    to: bill.to,
    summary,
    particulars,
    footer: bill.footer,
  };
}

function gstBillDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function splitGstTaxLines(lines: BillTotalLine[]) {
  let net18 = 0;
  let sgst = 0;
  let cgst = 0;
  let net20 = 0;
  let vat = 0;
  let netSur = 0;
  let sur = 0;
  let roundOff = 0;
  for (const line of lines) {
    const label = String(line.label || "");
    if (label.startsWith("CGST")) {
      cgst += line.amount;
      net18 += Number(line.base) || 0;
    } else if (label.startsWith("SGST")) {
      sgst += line.amount;
    } else if (label.startsWith("Vat")) {
      vat += line.amount;
      net20 += Number(line.base) || 0;
    } else if (label === "Surcharge") {
      sur += line.amount;
      netSur += Number(line.base) || 0;
    } else if (label === "Round Off") {
      roundOff += line.amount;
    }
  }
  return { net18, sgst, cgst, net20, vat, netSur, sur, roundOff };
}

/** Bill-wise FnB GST Report grid (Refresh view). */
export function gstBillWise(
  ctx: AppContext,
  from?: string,
  to?: string,
  filters?: { outlet?: string; billNo?: string; taxReport?: string },
) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  const where = ["i.created_at BETWEEN ? AND ?", "i.status IN ('PAID','UNPAID','PARTIAL')"];
  const args: Array<string | number> = [range.from, range.to];
  const outlet = String(filters?.outlet || "").trim();
  if (outlet && outlet !== "Select") {
    where.push("COALESCE(NULLIF(t.outlet, ''), 'BAR') = ?");
    args.push(outlet);
  }
  if (filters?.billNo?.trim()) {
    const bill = filters.billNo.trim().replace(/^.*\//, "");
    where.push("(i.invoice_number = ? OR i.invoice_number LIKE ? OR i.invoice_number LIKE ?)");
    args.push(bill, `%/${bill}`, `%${bill}`);
  }

  const invoices = ctx.db
    .prepare(
      `SELECT i.id AS invoice_id, i.invoice_number AS bill_no, i.created_at, i.discount,
              i.food_total, i.drinks_total, i.service_charge, i.service_charge_pct, i.tax,
              i.other_charges, i.grand_total,
              COALESCE(NULLIF(i.customer_display_name, ''), cu.name, '') AS client_name,
              COALESCE(i.customer_gstin, '') AS customer_gstin
       FROM invoices i
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN customers cu ON cu.id = i.customer_id
       WHERE ${where.join(" AND ")}
       ORDER BY i.created_at, i.invoice_number`,
    )
    .all(...args) as Array<Record<string, unknown>>;

  const itemStmt = ctx.db.prepare(
    `SELECT ii.amount AS amount, COALESCE(p.tax_rate, 0) AS tax_rate, p.sales_group AS sales_group
     FROM invoice_items ii
     LEFT JOIN products p ON p.id = ii.product_id
     WHERE ii.invoice_id = ?`,
  );
  const payStmt = ctx.db.prepare(
    `SELECT method, COALESCE(NULLIF(reference, ''), '') AS account, COALESCE(SUM(amount), 0) AS amount
     FROM payments WHERE invoice_id = ? GROUP BY method, account`,
  );

  const taxReport = String(filters?.taxReport || "all").toLowerCase();
  const rows: Array<Record<string, unknown>> = [];
  for (const inv of invoices) {
    const food = Number(inv.food_total) || 0;
    const drinks = Number(inv.drinks_total) || 0;
    if (taxReport === "liquor" && drinks <= 0) continue;
    if (taxReport === "fnb" && food <= 0) continue;

    const lines = itemStmt.all(String(inv.invoice_id)) as Array<{
      amount: number;
      tax_rate: number;
      sales_group: string | null;
    }>;
    const taxLines = buildBillTotalLines({
      lines: lines.map((l) => ({
        amount: Number(l.amount) || 0,
        taxRate: Number(l.tax_rate) || 0,
        salesGroup: l.sales_group,
      })),
      discount: Number(inv.discount) || 0,
      discountPct: 0,
      serviceCharge: Number(inv.service_charge) || 0,
      serviceChargePct:
        Number(inv.service_charge_pct ?? 0) !== 0 || Number(inv.service_charge) === 0
          ? Number(inv.service_charge_pct ?? 0)
          : 10,
      otherCharges: Number(inv.other_charges) || 0,
      roundOff: 0,
      taxTotal: Number(inv.tax) || 0,
    });
    const tax = splitGstTaxLines(taxLines);
    const amount = food + drinks;
    const discount = Number(inv.discount) || 0;
    const pays = payStmt.all(String(inv.invoice_id)) as Array<{ method: string; account: string; amount: number }>;
    const mopParts: string[] = [];
    for (const p of pays) {
      const label = mopParticularLabel(p.method, p.account);
      if (label && !mopParts.includes(label)) mopParts.push(label);
    }
    const primaryMop = mopParts[0] || "";
    const mopShort = primaryMop.startsWith("BANK TRANSFER")
      ? "BANK TRANSFER"
      : primaryMop === "PREPAID CARD"
        ? "PREPAID CARD"
        : primaryMop || "";
    rows.push({
      invoice_id: inv.invoice_id,
      bill_no: String(inv.bill_no || ""),
      bill_date: gstBillDate(String(inv.created_at || "")),
      client_name: String(inv.client_name || ""),
      gstin: String(inv.customer_gstin || ""),
      amount,
      discount,
      gross_amount: Math.max(0, amount - discount),
      service_charge: Number(inv.service_charge) || 0,
      net_18: tax.net18,
      sgst_9: tax.sgst,
      cgst_9: tax.cgst,
      net_20: tax.net20,
      vat_20: tax.vat,
      net_surchar: tax.netSur,
      surchar_20: tax.sur,
      round_off: tax.roundOff,
      net_amount: Number(inv.grand_total) || 0,
      // Native MOP cell looks like "0.00/- BANK TRANSFER"
      mop: mopShort ? `0.00/- ${mopShort}` : "",
      payment_modes: mopParts.join(", "),
      food_total: food,
      drinks_total: drinks,
    });
  }

  const sum = (key: string) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  const columnTotals = {
    amount: sum("amount"),
    discount: sum("discount"),
    gross_amount: sum("gross_amount"),
    service_charge: sum("service_charge"),
    net_18: sum("net_18"),
    sgst_9: sum("sgst_9"),
    cgst_9: sum("cgst_9"),
    net_20: sum("net_20"),
    vat_20: sum("vat_20"),
    net_surchar: sum("net_surchar"),
    surchar_20: sum("surchar_20"),
    round_off: sum("round_off"),
    net_amount: sum("net_amount"),
  };

  const mopRows = ctx.db
    .prepare(
      `SELECT p.method AS method, COALESCE(SUM(p.amount),0) AS amount
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN dining_tables t ON t.id = i.table_id
       WHERE i.created_at BETWEEN ? AND ? AND i.status IN ('PAID','UNPAID','PARTIAL')
         ${outlet && outlet !== "Select" ? "AND COALESCE(NULLIF(t.outlet, ''), 'BAR') = ?" : ""}
       GROUP BY p.method`,
    )
    .all(...(outlet && outlet !== "Select" ? [range.from, range.to, outlet] : [range.from, range.to])) as Array<{
    method: string;
    amount: number;
  }>;

  let cash = 0;
  let bank = 0;
  let prepaid = 0;
  for (const m of mopRows) {
    const method = String(m.method || "");
    const amt = Number(m.amount) || 0;
    if (method === "CASH") cash += amt;
    else if (method === "MEMBER_CARD") prepaid += amt;
    else if (method === "CARD" || method === "UPI") bank += amt;
  }

  const advance = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(advance), 0) AS n FROM bookings WHERE created_at BETWEEN ? AND ?`,
    )
    .get(range.from, range.to) as { n: number };

  return {
    from: range.start,
    to: range.end,
    rows,
    totals: columnTotals,
    footer: {
      advance: Number(advance?.n) || 0,
      bank,
      cash,
      prepaid,
      liquor: sum("drinks_total"),
      food: sum("food_total"),
    },
  };
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
  const where = ["p.created_at BETWEEN ? AND ?", "COALESCE(i.complimentary_account_id, '') = ''"];
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
              t.code AS table_code,
              ${INVOICE_ORDER_CARD} AS order_card,
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
    stampClubTable(row);
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
  const row = ctx.db
    .prepare(
      `SELECT p.id AS payment_id, p.receipt_no, p.voucher_no, COALESCE(p.remark, '') AS remark,
              p.method, p.amount, COALESCE(p.reference, '') AS account, p.created_at AS voucher_date,
              p.member_card_id, p.ledger_id, mc.card_number AS card_number,
              i.id AS invoice_id, i.invoice_number AS bill_no, i.grand_total AS bill_amount,
              i.discount AS allowance, i.status, i.order_id,
              COALESCE(NULLIF(t.name, ''), t.code) AS table_no,
              t.code AS table_code,
              ${INVOICE_ORDER_CARD} AS order_card,
              COALESCE(t.outlet, 'BAR') AS outlet_name,
              cu.name AS guest,
              (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = i.id) AS paid
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN customers cu ON cu.id = i.customer_id
       LEFT JOIN member_cards mc ON mc.id = p.member_card_id
       WHERE p.id = ?`,
    )
    .get(paymentId) as Record<string, unknown> | undefined;
  return row ? stampClubTable(row) : undefined;
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
    // When changing the mode for only part of an existing settlement, retain
    // the unmodified remainder under its original payment mode.
    if (method !== current && amount < Number(row.amount)) {
      const remainder = Number(row.amount) - amount;
      ctx.db.prepare("UPDATE payments SET method = ?, amount = ?, reference = ?, remark = ? WHERE id = ?")
        .run(method, amount, storedAccount, remark, paymentId);
      const splitPaymentId = uuid();
      ctx.db.prepare(
        `INSERT INTO payments (id, invoice_id, method, amount, member_card_id, ledger_id, reference, remark, receipt_no, voucher_no, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`
      ).run(
        splitPaymentId,
        row.invoice_id,
        current,
        remainder,
        String(row.account || ""),
        String(row.remark || ""),
        nextSequence(ctx.db, "settlement_receipt", 32901),
        nextSequence(ctx.db, "settlement_voucher", 47201),
        nowIso(),
      );
      applyPaidStatus(ctx, String(row.invoice_id), String(row.order_id), Number(row.bill_amount), Number(row.paid));
      audit(ctx, "SETTLEMENT_UPDATE", "payment", paymentId, null, row.amount, {
        splitPaymentId,
        retainedAmount: remainder,
        retainedMethod: current,
        method,
        amount,
        account: storedAccount,
      });
      return settlementRow(ctx, splitPaymentId);
    }
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

function stampKotDate(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getDate()).padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function stampKotTime(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${String(h).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")} ${ap}`;
}

export function kotReport(
  ctx: AppContext,
  from?: string,
  to?: string,
  station?: string,
  filters?: {
    outlet?: string;
    kotNo?: string;
    tableNo?: string;
    billNo?: string;
    complementary?: string;
  },
) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  const where = ["k.created_at BETWEEN ? AND ?"];
  const args: string[] = [range.from, range.to];
  if (station) {
    where.push("k.station = ?");
    args.push(station);
  }
  const outlet = String(filters?.outlet || "").trim();
  if (outlet && outlet !== "Select") {
    where.push("COALESCE(NULLIF(t.outlet, ''), 'BAR') = ?");
    args.push(outlet);
  }
  if (filters?.kotNo?.trim()) {
    const kot = filters.kotNo.trim().replace(/\D/g, "") || filters.kotNo.trim();
    where.push("(REPLACE(k.kot_number, 'KOT-', '') LIKE ? OR k.kot_number LIKE ?)");
    args.push(`%${kot}%`, `%${kot}%`);
  }
  if (filters?.tableNo?.trim()) {
    const q = `%${filters.tableNo.trim()}%`;
    where.push(`(t.code LIKE ? OR t.name LIKE ? OR ${KOT_ORDER_CARD} LIKE ? OR (${KOT_ORDER_CARD} || '/' || t.code) LIKE ?)`);
    args.push(q, q, q, q);
  }
  if (filters?.billNo?.trim()) {
    const bill = filters.billNo.trim().replace(/^.*\//, "");
    where.push(
      `EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.order_id = k.order_id
            AND (i.invoice_number = ? OR i.invoice_number LIKE ? OR i.invoice_number LIKE ?)
       )`,
    );
    args.push(bill, `%/${bill}`, `%${bill}`);
  }
  const comp = String(filters?.complementary || "Select").trim();
  const complimentaryInvoice = `EXISTS (
    SELECT 1 FROM invoices ci
     WHERE ci.order_id = k.order_id
       AND ci.complimentary_account_id IS NOT NULL
       AND ci.status NOT IN ('CANCELLED','VOID')
  )`;
  if (comp === "Yes") {
    where.push(`(IFNULL(k.notes,'') LIKE '%COMPLIM%' OR IFNULL(k.notes,'') LIKE '%complementary%' OR ${complimentaryInvoice})`);
  } else if (comp === "No") {
    where.push(`(IFNULL(k.notes,'') NOT LIKE '%COMPLIM%' AND IFNULL(k.notes,'') NOT LIKE '%complementary%' AND NOT ${complimentaryInvoice})`);
  }

  const sql = `SELECT k.id, k.kot_number, '' AS manual_kot,
                      COALESCE(NULLIF(t.name, ''), t.code) AS table_no,
                      t.code AS table_code,
                      ${KOT_ORDER_CARD} AS order_card,
                      k.created_at, k.notes AS kot_remark, k.station, k.status, k.type,
                      COALESCE(s.name, '') AS steward,
                      COALESCE(s.username, k.station, '') AS user_id,
                      COALESCE(NULLIF(t.outlet, ''), 'BAR') AS outlet_name,
                      (SELECT i.invoice_number FROM invoices i WHERE i.order_id = k.order_id ORDER BY i.created_at DESC LIMIT 1) AS bill_no,
                      (SELECT COALESCE(SUM(oi.unit_price * ki2.qty), 0)
                         FROM kot_items ki2
                         LEFT JOIN order_items oi ON oi.id = ki2.order_item_id
                        WHERE ki2.kot_id = k.id) AS net_amount
               FROM kots k
               JOIN dining_tables t ON t.id = k.table_id
               LEFT JOIN staff s ON s.id = k.waiter_id
               WHERE ${where.join(" AND ")}
               ORDER BY k.created_at`;
  const rows = (ctx.db.prepare(sql).all(...args) as Array<Record<string, unknown>>).map((r) => {
    const created = String(r.created_at || "");
    const kotRaw = String(r.kot_number || "");
    const billRaw = String(r.bill_no || "");
    return stampClubTable({
      ...r,
      kot_number: kotRaw.replace(/\D/g, "") || kotRaw,
      bill_no: billRaw.includes("/") ? billRaw.slice(billRaw.lastIndexOf("/") + 1).replace(/\D/g, "") || billRaw : billRaw.replace(/\D/g, "") || billRaw || "0",
      kot_date: stampKotDate(created),
      kot_time: stampKotTime(created),
    });
  });
  return { from: range.start, to: range.end, outlet: outlet || "", rows };
}

export function kotDetail(ctx: AppContext, kotKey: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const key = String(kotKey || "").trim();
  const kot = ctx.db
    .prepare(
      `SELECT k.id, k.kot_number, k.notes, k.station, k.status, k.type, k.created_at, k.order_id, k.table_id,
              COALESCE(NULLIF(t.name, ''), t.code) AS table_no,
              t.code AS table_code,
              COALESCE(NULLIF(t.outlet, ''), 'BAR') AS outlet_name,
              ${KOT_ORDER_CARD} AS order_card,
              COALESCE(s.name, '') AS waiter,
              (SELECT i.invoice_number FROM invoices i WHERE i.order_id = k.order_id ORDER BY i.created_at DESC LIMIT 1) AS bill_no
       FROM kots k
       JOIN dining_tables t ON t.id = k.table_id
       LEFT JOIN staff s ON s.id = k.waiter_id
       WHERE k.id = ? OR k.kot_number = ?`,
    )
    .get(key, key) as Record<string, unknown> | undefined;
  if (!kot) throw new AppError("KOT not found", 404);

  const items = ctx.db
    .prepare(
      `SELECT ki.id, ki.name, ki.qty, COALESCE(ki.notes, '') AS remark,
              COALESCE(oi.unit_price, 0) AS rate,
              COALESCE(p.sku, '') AS code
       FROM kot_items ki
       LEFT JOIN order_items oi ON oi.id = ki.order_item_id
       LEFT JOIN products p ON p.id = ki.product_id
       WHERE ki.kot_id = ?
       ORDER BY ki.rowid`,
    )
    .all(String(kot.id)) as Array<{ id: string; name: string; qty: number; remark: string; rate: number; code: string }>;

  const tableItems = ctx.db
    .prepare(
      `SELECT COALESCE(p.sku, '') AS code, oi.name, SUM(oi.qty) AS qty,
              SUM(oi.qty * oi.unit_price) AS amount
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ? AND oi.voided = 0
       GROUP BY oi.product_id, oi.name, p.sku
       ORDER BY MIN(oi.rowid)`,
    )
    .all(String(kot.order_id)) as Array<{ code: string; name: string; qty: number; amount: number }>;

  const netAmount = items.reduce((s, i) => s + i.rate * i.qty, 0);
  const totalAmount = tableItems.reduce((s, i) => s + Number(i.amount || 0), 0);

  return stampClubTable({
    ...kot,
    date_label: (() => {
      const iso = String(kot.created_at || "");
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      let h = d.getHours();
      const ap = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      return `${String(d.getDate()).padStart(2, "0")}-${months[d.getMonth()]}-${d.getFullYear()} ${String(h).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")} ${ap}`;
    })(),
    items,
    table_items: tableItems,
    net_amount: netAmount,
    total_amount: totalAmount,
  });
}

export function billReport(
  ctx: AppContext,
  from?: string,
  to?: string,
  filters?: {
    outlet?: string;
    billNo?: string;
    tableNo?: string;
    status?: "all" | "active" | "cancelled";
    discountedOnly?: boolean;
  },
) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const range = dateRange(from, to);
  const where = ["i.created_at BETWEEN ? AND ?"];
  const args: Array<string | number> = [range.from, range.to];
  const outlet = String(filters?.outlet || "").trim();
  if (outlet && outlet !== "Select") {
    where.push("COALESCE(NULLIF(t.outlet, ''), 'BAR') = ?");
    args.push(outlet);
  }
  if (filters?.billNo?.trim()) {
    // Match short bill id (10023) or full (26-27/10023)
    const bill = filters.billNo.trim().replace(/^.*\//, "");
    where.push("(i.invoice_number = ? OR i.invoice_number LIKE ? OR i.invoice_number LIKE ?)");
    args.push(bill, `%/${bill}`, `%${bill}`);
  }
  if (filters?.tableNo?.trim()) {
    const q = `%${filters.tableNo.trim()}%`;
    where.push(`(t.code LIKE ? OR t.name LIKE ? OR ${INVOICE_ORDER_CARD} LIKE ? OR (${INVOICE_ORDER_CARD} || '/' || t.code) LIKE ?)`);
    args.push(q, q, q, q);
  }
  const status = filters?.status || "all";
  if (status === "active") where.push("i.status IN ('UNPAID','PARTIAL')");
  else if (status === "cancelled") where.push("i.status IN ('VOID','CANCELLED')");
  else where.push("i.status IN ('UNPAID','PARTIAL','PAID','VOID','CANCELLED')");
  if (filters?.discountedOnly) where.push("COALESCE(i.discount, 0) > 0");

  const invoices = ctx.db
    .prepare(
      `SELECT i.id AS invoice_id, i.order_id, i.invoice_number, i.table_id,
              COALESCE(NULLIF(t.name, ''), t.code) AS table_no,
              t.code AS table_code,
              ${INVOICE_ORDER_CARD} AS order_card,
              i.grand_total, i.status, i.created_at, i.discount, i.service_charge,
              i.food_total, i.drinks_total, cu.name AS guest, cu.mobile AS mobile,
              COALESCE(NULLIF(t.outlet, ''), 'BAR') AS outlet_name,
              s.name AS username,
              (SELECT p.id FROM payments p WHERE p.invoice_id = i.id ORDER BY p.created_at DESC LIMIT 1) AS payment_id,
              COALESCE(
                NULLIF((SELECT COALESCE(p.remark, '') FROM payments p WHERE p.invoice_id = i.id ORDER BY p.created_at DESC LIMIT 1), ''),
                COALESCE(i.complimentary_name, '')
              ) AS remark
       FROM invoices i
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN customers cu ON cu.id = i.customer_id
       LEFT JOIN staff s ON s.id = i.cashier_id
       WHERE ${where.join(" AND ")}
       ORDER BY i.created_at, i.invoice_number`,
    )
    .all(...args) as Array<Record<string, unknown>>;

  const payStmt = ctx.db.prepare(
    `SELECT method, COALESCE(SUM(amount), 0) AS amount
       FROM payments WHERE invoice_id = ? GROUP BY method`,
  );

  const rows = invoices.map((row) => {
    const pays = payStmt.all(String(row.invoice_id)) as Array<{ method: string; amount: number }>;
    let cash = 0;
    let card = 0;
    let other = 0;
    for (const p of pays) {
      const m = String(p.method || "");
      const amt = Number(p.amount) || 0;
      if (m === "CASH") cash += amt;
      else if (m === "CARD" || m === "UPI") card += amt;
      else other += amt;
    }
    return stampClubTable({
      ...row,
      net_amount: Number(row.grand_total) || 0,
      service_charge: Number(row.service_charge) || 0,
      cash,
      card,
      btc: 0,
      wallet: 0,
      room_transfer: 0,
      other_mod: other,
      allowance: Number(row.discount) || 0,
      remark: String(row.remark || ""),
      username: String(row.username || ""),
    });
  });

  const total = rows.reduce((s, r) => s + (Number(r.net_amount) || 0), 0);
  return {
    from: range.start,
    to: range.end,
    outlet: outlet || "",
    rows,
    total,
  };
}

/** One row per card recharge. Remaining balance is the card balance at the end of that recharge, before the next recharge of the same card. */
export function cardSettlementReport(ctx: AppContext, from?: string, to?: string, cardNo?: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  let start = from || todayDate();
  let end = to || start;
  if (start > end) [start, end] = [end, start];
  const range = dateRange(start, end);
  const card = (cardNo || "").trim();
  const rows = ctx.db
    .prepare(
      `WITH seq AS (
         SELECT id, card_no, guest_name, advance, created_at,
                LEAD(created_at) OVER (PARTITION BY card_no ORDER BY created_at, id) AS next_at
         FROM bookings
         WHERE card_no != '' AND (? = '' OR card_no = ?)
       )
       SELECT b.id AS booking_id, b.card_no,
              CASE
                WHEN TRIM(COALESCE(b.guest_name, '')) != '' THEN TRIM(b.guest_name)
                ELSE COALESCE(cu.name, '')
              END AS guest_name,
              b.created_at AS booking_date,
              b.advance AS card_balance,
              MAX(0, COALESCE((
                SELECT l.new_paid + l.new_bonus
                FROM card_ledger l
                WHERE l.card_id = mc.id
                  AND l.created_at >= b.created_at
                  AND l.created_at < COALESCE(b.next_at, '9999-12-31T23:59:59.999Z')
                ORDER BY l.created_at DESC
                LIMIT 1
              ), CASE WHEN b.next_at IS NULL
                   THEN COALESCE(mc.paid_balance, 0) + COALESCE(mc.bonus_balance, 0)
                   ELSE 0 END)) AS remaining_balance
       FROM seq b
       LEFT JOIN member_cards mc ON mc.card_number = b.card_no
       LEFT JOIN customers cu ON cu.id = mc.customer_id
       WHERE b.created_at BETWEEN ? AND ?
       ORDER BY b.created_at, b.card_no, b.id`,
    )
    .all(card, card, range.from, range.to) as Array<Record<string, unknown>>;
  return { from: range.start, to: range.end, card_no: card, rows };
}

export function cardSettlementBills(ctx: AppContext, bookingId: string) {
  assertPermission(ctx.actor.role, "VIEW_REPORTS");
  const booking = ctx.db
    .prepare(
      `SELECT b.id, b.card_no, b.created_at,
              (SELECT b2.created_at FROM bookings b2
               WHERE b2.card_no = b.card_no AND b2.created_at > b.created_at
               ORDER BY b2.created_at
               LIMIT 1) AS next_at
       FROM bookings b
       WHERE b.id = ?`,
    )
    .get(bookingId) as { id: string; card_no: string; created_at: string; next_at: string | null } | undefined;
  if (!booking) throw new AppError("Booking not found", 404);
  const card = ctx.db
    .prepare("SELECT id FROM member_cards WHERE card_number = ?")
    .get(booking.card_no) as { id: string } | undefined;
  if (!card) {
    return { booking_id: booking.id, card_no: booking.card_no, rows: [] };
  }
  const next = booking.next_at || "9999-12-31T23:59:59.999Z";
  const rows = ctx.db
    .prepare(
      `SELECT i.id AS invoice_id,
              MIN(i.invoice_number) AS invoice_number,
              MIN(COALESCE(NULLIF(t.name, ''), t.code)) AS table_no,
              MIN(t.code) AS table_code,
              MIN(${INVOICE_ORDER_CARD}) AS order_card,
              MIN(COALESCE(NULLIF(t.outlet, ''), 'BAR')) AS outlet,
              SUM(p.amount) AS amount
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN dining_tables t ON t.id = i.table_id
       WHERE p.method = 'MEMBER_CARD'
         AND p.member_card_id = ?
         AND p.created_at >= ?
         AND p.created_at < ?
       GROUP BY i.id
       ORDER BY MIN(p.created_at), invoice_number`,
    )
    .all(card.id, booking.created_at, next) as Array<Record<string, unknown>>;
  return { booking_id: booking.id, card_no: booking.card_no, rows: rows.map(stampClubTable) };
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
