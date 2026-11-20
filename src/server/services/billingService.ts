import { assertPermission } from "../../shared/permissions.js";
import { formatINR } from "../../shared/money.js";
import { AppError, InsufficientBalanceError } from "../lib/errors.js";
import { audit, enqueueSync } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { idempotencyKey, nextBillNumber, nextSequence, nowIso, peekNextBillNumber, uuid } from "../lib/ids.js";
import type { PaymentLine, ServiceChargeMode } from "../../shared/types.js";
import { purchaseOnCard, refundToCard, getCard, expireOvernightBalance, allocateSpend, writeLedger } from "./cardService.js";
import { closeTable, getTable, setTableStatus } from "./tableService.js";
import { printedTableNo } from "./tableLabel.js";
import { formatTableNo } from "../../shared/tableLabel.js";
import { billPrintMode, renderBillReceiptHtml } from "../hardware/billReceiptHtml.js";
import { buildBillTotalLines } from "../hardware/billTotals.js";
import { getServiceCharge, getVenueProfile } from "./settingsService.js";
import { displayTaxRate } from "./itemService.js";

export interface BillPreview {
  orderId: string;
  sessionId: string;
  tableId: string;
  tableCode: string;
  foodTotal: number;
  drinksTotal: number;
  tax: number;
  serviceCharge: number;
  serviceChargePct: number;
  serviceChargeMode: ServiceChargeMode;
  discount: number;
  otherCharges: number;
  grandTotal: number;
  items: Array<{
    id: string;
    ids: string[];
    name: string;
    station: string;
    qty: number;
    unit_price: number;
    amount: number;
    tax_rate: number;
    tax: number;
  }>;
  totalQty: number;
  discountPct: number;
  roundOff: number;
  invoiceNumber: string;
}

export function previewBill(
  ctx: AppContext,
  orderId: string,
  options: {
    discount?: number;
    discountPct?: number;
    /** `amount` uses `discount` paise. Anything else uses `discountPct` on items that are not excluded. */
    discountFrom?: "amount" | "percent";
    /** Order item ids that take no discount. */
    excludeItemIds?: string[];
    otherCharges?: number;
    serviceChargePct?: number;
    serviceChargeMode?: ServiceChargeMode;
  } = {},
): BillPreview {
  const order = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as
    | { id: string; session_id: string; table_id: string }
    | undefined;
  if (!order) throw new AppError("Order not found", 404);
  getTable(ctx, order.table_id);
  const items = ctx.db
    .prepare(
      `SELECT oi.*, p.tax_rate AS product_tax_rate, p.sales_group AS product_sales_group
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? AND oi.voided = 0
        ORDER BY oi.rowid`,
    )
    .all(orderId) as Array<{
    id: string;
    product_id: string;
    name: string;
    station: string;
    qty: number;
    unit_price: number;
    tax_rate: number;
    product_tax_rate: number | null;
    product_sales_group: string | null;
  }>;
  if (!items.length) throw new AppError("Bill has no items");

  const mapped = groupSameItems(items.map((i) => {
    const tax_rate = displayTaxRate(ctx, {
      name: i.name,
      salesGroup: i.product_sales_group,
      productTaxRate: i.product_tax_rate,
      lineTaxRate: i.tax_rate,
    });
    const amount = i.qty * i.unit_price;
    return {
      id: i.id,
      ids: [i.id],
      product_id: i.product_id,
      name: i.name,
      station: i.station,
      qty: i.qty,
      unit_price: i.unit_price,
      amount,
      tax_rate,
      sales_group: i.product_sales_group ?? "",
      tax: 0,
    };
  }));
  const foodTotal = mapped.filter((i) => i.station === "KITCHEN").reduce((s, i) => s + i.amount, 0);
  const drinksTotal = mapped.filter((i) => i.station === "BAR").reduce((s, i) => s + i.amount, 0);
  const subtotal = foodTotal + drinksTotal;
  const excluded = new Set(options.excludeItemIds ?? []);
  const discountable = mapped.filter((i) => !i.ids.some((id) => excluded.has(id))).reduce((s, i) => s + i.amount, 0);
  const configured = getServiceCharge(ctx);
  const pct = options.serviceChargePct ?? configured.pct;
  const mode = options.serviceChargeMode ?? configured.mode;
  const fromAmount = options.discountFrom === "amount" || (options.discount != null && options.discountPct == null && options.discountFrom !== "percent");
  let discount: number;
  let discountPct: number;
  if (fromAmount) {
    discount = Math.max(0, Math.min(Math.round(options.discount ?? 0), discountable));
    discountPct = discountable ? Math.round((discount / discountable) * 10000) / 100 : 0;
  } else {
    discountPct = Math.max(0, options.discountPct ?? 0);
    discount = Math.min(discountable, Math.round((discountable * discountPct) / 100));
  }
  // Tax after discount (THE BOSS slip bases are post-discount)
  const discable = mapped.filter((i) => !i.ids.some((id) => excluded.has(id)) && i.amount > 0);
  let allocatedDisc = 0;
  for (let i = 0; i < mapped.length; i++) {
    const line = mapped[i];
    const canDisc = !line.ids.some((id) => excluded.has(id)) && line.amount > 0;
    let lineDisc = 0;
    if (canDisc && discount > 0 && discountable > 0) {
      const isLast = line === discable[discable.length - 1];
      lineDisc = isLast
        ? Math.max(0, discount - allocatedDisc)
        : Math.round((discount * line.amount) / discountable);
      if (lineDisc > line.amount) lineDisc = line.amount;
      allocatedDisc += lineDisc;
    }
    const taxable = Math.max(0, line.amount - lineDisc);
    line.tax = Math.round((taxable * line.tax_rate) / 100);
  }
  const tax = mapped.reduce((s, i) => s + i.tax, 0);
  const otherCharges = options.otherCharges ?? 0;
  const afterDiscount = Math.max(0, subtotal - discount);
  const serviceCharge =
    mode === "INCLUSIVE" ? Math.round(afterDiscount - afterDiscount / (1 + pct / 100)) : Math.round((afterDiscount * pct) / 100);
  const unrounded =
    mode === "INCLUSIVE" ? afterDiscount + tax + otherCharges : afterDiscount + serviceCharge + tax + otherCharges;
  const grandTotal = Math.round(unrounded / 100) * 100;
  const roundOff = grandTotal - unrounded;

  return {
    orderId: order.id,
    sessionId: order.session_id,
    tableId: order.table_id,
    tableCode: printedTableNo(ctx, { tableId: order.table_id, orderId: order.id }),
    foodTotal,
    drinksTotal,
    tax,
    serviceCharge,
    serviceChargePct: pct,
    serviceChargeMode: mode,
    discount,
    discountPct,
    otherCharges,
    roundOff,
    totalQty: mapped.reduce((s, i) => s + i.qty, 0),
    grandTotal,
    items: mapped,
    invoiceNumber: openInvoiceNumber(ctx, orderId),
  };
}

function groupSameItems<T extends { id: string; ids: string[]; product_id: string; name: string; unit_price: number; tax_rate: number; qty: number; amount: number; tax: number; sales_group?: string }>(
  lines: T[],
): T[] {
  const groups = new Map<string, T>();
  for (const line of lines) {
    const key = `${line.product_id}|${line.unit_price}|${line.tax_rate}|${line.name}`;
    const found = groups.get(key);
    if (!found) {
      groups.set(key, { ...line, ids: [line.id] });
      continue;
    }
    found.qty += line.qty;
    found.amount += line.amount;
    found.tax += line.tax;
    found.ids.push(line.id);
  }
  return [...groups.values()].filter((line) => line.qty !== 0);
}

function orderOutlet(ctx: AppContext, orderId: string) {
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(NULLIF(s.outlet, ''), NULLIF(t.outlet, ''), 'BAR') AS outlet
         FROM orders o
         JOIN dining_tables t ON t.id = o.table_id
         LEFT JOIN table_sessions s ON s.id = o.session_id
        WHERE o.id = ?`,
    )
    .get(orderId) as { outlet: string } | undefined;
  return row?.outlet || "BAR";
}

function requireComplimentary(ctx: AppContext, accountId: string | undefined) {
  const id = String(accountId ?? "").trim();
  if (!id) throw new AppError("Select Complimentary A/C");
  const account = ctx.db
    .prepare("SELECT id, name FROM complimentary_accounts WHERE id = ?")
    .get(id) as { id: string; name: string } | undefined;
  if (!account) throw new AppError("Select Complimentary A/C");
  return account;
}

function zeroComplimentaryBill(bill: BillPreview) {
  bill.foodTotal = 0;
  bill.drinksTotal = 0;
  bill.serviceCharge = 0;
  bill.serviceChargePct = 0;
  bill.discount = 0;
  bill.discountPct = 0;
  bill.tax = 0;
  bill.otherCharges = 0;
  bill.roundOff = 0;
  bill.grandTotal = 0;
  for (const item of bill.items) {
    item.amount = 0;
    item.tax = 0;
  }
}

/** NC is saved at zero and closed. No payment row, so it stays off the settlement report. */
function finishComplimentary(ctx: AppContext, orderId: string, invoiceId: string, tableId: string) {
  const now = nowIso();
  ctx.db.prepare("UPDATE invoices SET status = 'PAID', paid_at = COALESCE(paid_at, ?) WHERE id = ?").run(now, invoiceId);
  ctx.db.prepare("UPDATE orders SET status = 'PAID' WHERE id = ?").run(orderId);
  closeTable(ctx, tableId);
  audit(ctx, "INVOICE_PAID", "invoice", invoiceId, "complimentary", 0, 0);
}

function openInvoiceNumber(ctx: AppContext, orderId: string): string {
  const existing = ctx.db
    .prepare("SELECT invoice_number FROM invoices WHERE order_id = ? AND status IN ('UNPAID','PARTIAL')")
    .get(orderId) as { invoice_number: string } | undefined;
  if (existing) return existing.invoice_number;
  return peekNextBillNumber(ctx.db);
}

export function generateInvoice(
  ctx: AppContext,
  orderId: string,
  options: {
    invoiceId?: string;
    discount?: number;
    discountPct?: number;
    discountFrom?: "amount" | "percent";
    excludeItemIds?: string[];
    otherCharges?: number;
    serviceChargePct?: number;
    serviceChargeMode?: ServiceChargeMode;
    reason?: string;
    complimentary?: boolean;
    complimentaryAccountId?: string;
    customerDisplayName?: string;
    customerGstin?: string;
  } = {},
) {
  assertPermission(ctx.actor.role, "SETTLE_BILL");
  const preview = previewBill(ctx, orderId, options);
  const nc = orderOutlet(ctx, orderId) === "NC";
  const isComplimentary = nc || Boolean(options.complimentary);
  const comp = isComplimentary ? requireComplimentary(ctx, options.complimentaryAccountId) : null;
  if (isComplimentary) zeroComplimentaryBill(preview);
  if ((preview.discount ?? 0) > 0) {
    if (preview.discount > preview.foodTotal + preview.drinksTotal * 0.2) {
      assertPermission(ctx.actor.role, "LARGE_DISCOUNT");
    }
    audit(ctx, "DISCOUNT", "order", orderId, options.reason ?? "discount", 0, preview.discount);
  }

  const existing = options.invoiceId
    ? ctx.db
        .prepare("SELECT * FROM invoices WHERE id = ? AND order_id = ? AND status IN ('UNPAID','PARTIAL','PAID')")
        .get(options.invoiceId, orderId) as { id: string; status: string } | undefined
    : ctx.db
        .prepare(
          `SELECT * FROM invoices
            WHERE order_id = ? AND status IN ('UNPAID','PARTIAL','PAID')
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(orderId) as { id: string; status: string } | undefined;

  const bill = preview;
  const order = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as {
    customer_id: string | null;
    card_id: string | null;
  };
  function writeItems(invoiceId: string) {
    for (const item of bill.items) {
      ctx.db
        .prepare(
          `INSERT INTO invoice_items (id, invoice_id, order_item_id, product_id, name, station, qty, unit_price, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          uuid(),
          invoiceId,
          item.id,
          (ctx.db.prepare("SELECT product_id FROM order_items WHERE id = ?").get(item.id) as { product_id: string }).product_id,
          item.name,
          item.station,
          item.qty,
          item.unit_price,
          item.amount,
        );
    }
  }

  if (existing) {
    const paid = (ctx.db.prepare("SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?").get(existing.id) as { paid: number }).paid;
    return ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `UPDATE invoices SET
             food_total = ?, drinks_total = ?, service_charge = ?, service_charge_mode = ?, service_charge_pct = ?,
             discount = ?, tax = ?, other_charges = ?, grand_total = ?,
             complimentary_account_id = ?, complimentary_name = ?,
             customer_display_name = COALESCE(?, customer_display_name), customer_gstin = COALESCE(?, customer_gstin)
           WHERE id = ?`,
        )
        .run(
          bill.foodTotal,
          bill.drinksTotal,
          bill.serviceCharge,
          bill.serviceChargeMode,
          bill.serviceChargePct,
          bill.discount,
          bill.tax,
          bill.otherCharges,
          bill.grandTotal,
          comp?.id ?? null,
          comp?.name ?? "",
          options.customerDisplayName == null ? null : String(options.customerDisplayName).trim(),
          options.customerGstin == null ? null : String(options.customerGstin).trim(),
          existing.id,
        );
      ctx.db.prepare("DELETE FROM invoice_items WHERE invoice_id = ?").run(existing.id);
      writeItems(existing.id);
      // Keep edits to a settled bill on the invoice already referenced by its
      // payments. Recalculate its status so the reports show the revised bill
      // total while retaining the original payment history.
      const isPaid = bill.grandTotal > 0 && paid >= bill.grandTotal;
      ctx.db
        .prepare("UPDATE invoices SET status = ?, paid_at = CASE WHEN ? = 1 THEN COALESCE(paid_at, ?) ELSE NULL END WHERE id = ?")
        .run(isPaid ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID", isPaid ? 1 : 0, nowIso(), existing.id);
      ctx.db
        .prepare("UPDATE orders SET status = ? WHERE id = ?")
        .run(isPaid ? "PAID" : "SETTLING", orderId);
      if (isComplimentary) {
        syncClubCardCharge(ctx, orderId, true);
        finishComplimentary(ctx, orderId, existing.id, bill.tableId);
      } else syncClubCardCharge(ctx, orderId, true);
      return ctx.db.prepare("SELECT * FROM invoices WHERE id = ?").get(existing.id);
    })();
  }

  return ctx.db.transaction(() => {
    const id = uuid();
    const invoiceNumber = nextBillNumber(ctx.db);
    ctx.db
      .prepare(
        `INSERT INTO invoices (
           id, invoice_number, session_id, order_id, table_id, customer_id, card_id,
           food_total, drinks_total, service_charge, service_charge_mode, service_charge_pct,
           discount, tax, other_charges, grand_total, status, cashier_id, created_at, paid_at,
           complimentary_account_id, complimentary_name, customer_display_name, customer_gstin
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        invoiceNumber,
        bill.sessionId,
        bill.orderId,
        bill.tableId,
        order.customer_id,
        order.card_id,
        bill.foodTotal,
        bill.drinksTotal,
        bill.serviceCharge,
        bill.serviceChargeMode,
        bill.serviceChargePct,
        bill.discount,
        bill.tax,
        bill.otherCharges,
        bill.grandTotal,
        "UNPAID",
        ctx.actor.staffId,
        nowIso(),
        null,
        comp?.id ?? null,
        comp?.name ?? "",
        String(options.customerDisplayName ?? "").trim(),
        String(options.customerGstin ?? "").trim(),
      );
    writeItems(id);
    if (isComplimentary) {
      syncClubCardCharge(ctx, orderId, true);
      finishComplimentary(ctx, orderId, id, bill.tableId);
    } else {
      ctx.db.prepare("UPDATE orders SET status = 'SETTLING' WHERE id = ?").run(orderId);
      setTableStatus(ctx, bill.tableId, "PAYMENT_PENDING");
      syncClubCardCharge(ctx, orderId, true);
    }
    return ctx.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  })();
}

export function getInvoice(ctx: AppContext, invoiceId: string) {
  const invoice = ctx.db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId) as
    | Record<string, unknown>
    | undefined;
  if (!invoice) throw new AppError("Invoice not found", 404);
  const items = ctx.db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(invoiceId);
  const payments = ctx.db.prepare("SELECT * FROM payments WHERE invoice_id = ?").all(invoiceId) as Array<{
    amount: number;
  }>;
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  return { invoice, items, payments, paid, due: (invoice.grand_total as number) - paid };
}

function clubChargeRef(orderId: string) {
  return `club:${orderId}`;
}

/** Current club bill net with tax. Uses the open bill's discount when one is printed. */
function clubBillNet(ctx: AppContext, orderId: string) {
  const inv = ctx.db
    .prepare(
      `SELECT discount, service_charge_pct, service_charge_mode, other_charges, complimentary_account_id
         FROM invoices
        WHERE order_id = ? AND status IN ('UNPAID','PARTIAL')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(orderId) as
    | { discount: number; service_charge_pct: number; service_charge_mode: string; other_charges: number; complimentary_account_id: string | null }
    | undefined;
  if (inv?.complimentary_account_id) return 0;
  try {
    const bill = previewBill(
      ctx,
      orderId,
      inv
        ? {
            discount: Number(inv.discount) || 0,
            discountFrom: "amount",
            serviceChargePct: Number(inv.service_charge_pct) || 0,
            serviceChargeMode: (inv.service_charge_mode || "EXCLUSIVE") as ServiceChargeMode,
            otherCharges: Number(inv.other_charges) || 0,
          }
        : {},
    );
    return Math.max(0, bill.grandTotal);
  } catch {
    return 0;
  }
}

function clubChargeSoFar(ctx: AppContext, orderId: string) {
  return ctx.db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='DEBIT' THEN paid_amount ELSE -paid_amount END), 0) AS paid,
         COALESCE(SUM(CASE WHEN direction='DEBIT' THEN bonus_amount ELSE -bonus_amount END), 0) AS bonus
       FROM card_ledger WHERE reference_number = ?`,
    )
    .get(clubChargeRef(orderId)) as { paid: number; bonus: number };
}

/**
 * Take the current THE BOSS CLUB bill net off the card, or put the difference back
 * when the bill gets smaller. Punch, item edit, and cancel all call this.
 * `force` charges even before the KOT id is stored (Print KOT itself).
 */
export function syncClubCardCharge(ctx: AppContext, orderId: string, force = false) {
  const order = ctx.db
    .prepare(
      `SELECT o.id, o.card_id, o.status, COALESCE(s.outlet, t.outlet, 'BAR') AS outlet
         FROM orders o
         JOIN dining_tables t ON t.id = o.table_id
         LEFT JOIN table_sessions s ON s.id = o.session_id
        WHERE o.id = ?`,
    )
    .get(orderId) as { id: string; card_id: string | null; status: string; outlet: string } | undefined;
  if (!order || order.outlet !== "THE BOSS CLUB" || !order.card_id) return;
  if (order.status === "PAID" || order.status === "CANCELLED") return;
  const held = clubChargeSoFar(ctx, orderId);
  const already = held.paid + held.bonus;
  if (!force && already === 0) {
    const sent = ctx.db
      .prepare("SELECT 1 AS n FROM order_items WHERE order_id = ? AND kot_id IS NOT NULL AND voided = 0 LIMIT 1")
      .get(orderId);
    if (!sent) return;
  }
  const target = clubBillNet(ctx, orderId);
  const delta = target - already;
  if (delta === 0) return;
  const card = getCard(ctx, order.card_id);
  if (delta > 0) {
    expireOvernightBalance(ctx, card.id);
    let split: { paid: number; bonus: number };
    try {
      split = allocateSpend(ctx, card, delta);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        const available = Number((err.details as { available?: number } | undefined)?.available ?? 0);
        throw new AppError(
          `Insufficient amount  Card balance : ${(available / 100).toFixed(2)}`,
          409,
          "INSUFFICIENT_CARD_BALANCE",
          err.details,
        );
      }
      throw err;
    }
    writeLedger(ctx, {
      cardId: card.id,
      type: "ADJUSTMENT",
      direction: "DEBIT",
      paidAmount: split.paid,
      bonusAmount: split.bonus,
      paymentMode: "MEMBER_CARD",
      referenceNumber: clubChargeRef(orderId),
      reason: "THE BOSS CLUB order",
      idempotencyKey: idempotencyKey("club"),
    });
    return;
  }
  const give = -delta;
  const paidBack = Math.min(Math.max(0, held.paid), give);
  const bonusBack = give - paidBack;
  writeLedger(ctx, {
    cardId: card.id,
    type: "ADJUSTMENT",
    direction: "CREDIT",
    paidAmount: paidBack,
    bonusAmount: bonusBack,
    paymentMode: "MEMBER_CARD",
    referenceNumber: clubChargeRef(orderId),
    reason: "THE BOSS CLUB order",
    idempotencyKey: idempotencyKey("club"),
  });
}

/** Balance left on the card. Club punches are already deducted from the ledger. */
export function cardSpendable(ctx: AppContext, cardId: string, _exceptOrderId?: string) {
  const ledger = expireOvernightBalance(ctx, cardId);
  return {
    paid: ledger.paid,
    bonus: ledger.bonus,
    usable: ledger.usable,
    reserved: 0,
    available: ledger.usable,
  };
}

/** Close a Boss Club bill with the amount already taken from the card. Does not debit again. */
export function settleClubFromCard(ctx: AppContext, invoiceId: string) {
  const snap = getInvoice(ctx, invoiceId);
  const invoice = snap.invoice as {
    id: string;
    status: string;
    order_id: string;
    card_id: string | null;
    discount: number;
    service_charge_pct: number;
    service_charge_mode: string;
    other_charges: number;
  };
  if (invoice.status === "PAID" || invoice.status === "CANCELLED") throw new AppError(`Invoice is ${invoice.status}`);
  const order = ctx.db.prepare("SELECT card_id FROM orders WHERE id = ?").get(invoice.order_id) as
    | { card_id: string | null }
    | undefined;
  const cardId = invoice.card_id || order?.card_id;
  if (!cardId) throw new AppError("Punch the card on this table first");
  generateInvoice(ctx, invoice.order_id, {
    discount: Number(invoice.discount) || 0,
    discountFrom: "amount",
    serviceChargePct: Number(invoice.service_charge_pct) || 0,
    serviceChargeMode: (invoice.service_charge_mode || "EXCLUSIVE") as ServiceChargeMode,
    otherCharges: Number(invoice.other_charges) || 0,
  });
  const due = getInvoice(ctx, invoiceId).due;
  if (due <= 0) throw new AppError("Nothing to settle");
  return settleInvoice(
    ctx,
    invoiceId,
    [{ method: "MEMBER_CARD", amount: due, memberCardId: cardId }],
    { printReceipt: false },
  );
}

export function settleInvoice(
  ctx: AppContext,
  invoiceId: string,
  lines: PaymentLine[],
  options: { printReceipt?: boolean } = {},
) {
  assertPermission(ctx.actor.role, "SETTLE_BILL");
  if (!lines.length) throw new AppError("Add at least one payment");

  return ctx.db.transaction(() => {
    const snap = getInvoice(ctx, invoiceId);
    const invoice = snap.invoice as {
      id: string;
      invoice_number: string;
      grand_total: number;
      status: string;
      order_id: string;
      table_id: string;
      card_id: string | null;
    };
    if (invoice.status === "PAID" || invoice.status === "CANCELLED") {
      throw new AppError(`Invoice is ${invoice.status}`);
    }
    const place = ctx.db
      .prepare(
        `SELECT COALESCE(s.outlet, t.outlet, 'BAR') AS outlet
           FROM invoices i
           JOIN dining_tables t ON t.id = i.table_id
           LEFT JOIN table_sessions s ON s.id = i.session_id
          WHERE i.id = ?`,
      )
      .get(invoice.id) as { outlet: string };
    if (place.outlet === "THE BOSS CLUB" && lines.some((line) => line.method !== "MEMBER_CARD")) {
      throw new AppError("THE BOSS CLUB settles from the card");
    }

    let paid = snap.paid;
    const created = [];
    for (const line of lines) {
      if (line.amount <= 0) throw new AppError("Payment amount must be positive");
      let ledgerId: string | null = null;
      if (line.method === "MEMBER_CARD") {
        const cardId = line.memberCardId ?? invoice.card_id;
        if (!cardId) throw new AppError("Member card is required for card payment");
        if (place.outlet === "THE BOSS CLUB") {
          const held = ctx.db
            .prepare(
              `SELECT id FROM card_ledger
                WHERE reference_number = ? AND card_id = ?
                ORDER BY created_at DESC LIMIT 1`,
            )
            .get(clubChargeRef(invoice.order_id), cardId) as { id: string } | undefined;
          ledgerId = held?.id ?? null;
        } else {
          const spend = cardSpendable(ctx, cardId);
          if (line.amount > spend.available) throw new InsufficientBalanceError(line.amount, spend.available);
          try {
            const result = purchaseOnCard(ctx, {
              cardId,
              amount: line.amount,
              invoiceId: invoice.id,
              idempotencyKey: idempotencyKey("invpay"),
            });
            ledgerId = (result.txn as { id: string }).id;
          } catch (err) {
            if (err instanceof InsufficientBalanceError) throw err;
            throw err;
          }
        }
      }
      const paymentId = uuid();
      const account = line.reference ?? (line.method === "CASH" ? "Cash." : null);
      ctx.db
        .prepare(
          `INSERT INTO payments (id, invoice_id, method, amount, member_card_id, ledger_id, reference, remark, receipt_no, voucher_no, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
        )
        .run(
          paymentId,
          invoice.id,
          line.method,
          line.amount,
          line.memberCardId ?? invoice.card_id ?? null,
          ledgerId,
          account,
          nextSequence(ctx.db, "settlement_receipt", 32901),
          nextSequence(ctx.db, "settlement_voucher", 47201),
          nowIso(),
        );
      paid += line.amount;
      created.push(paymentId);
      if (line.method === "CASH") void ctx.hardware.drawer.open();
    }

    if (paid < invoice.grand_total) {
      ctx.db.prepare("UPDATE invoices SET status = 'PARTIAL' WHERE id = ?").run(invoice.id);
      enqueueSync(ctx, "invoice", invoice.id, { invoiceId, paid, due: invoice.grand_total - paid }, idempotencyKey("inv"));
      return { ...getInvoice(ctx, invoice.id), complete: false };
    }

    ctx.db
      .prepare("UPDATE invoices SET status = 'PAID', paid_at = ? WHERE id = ?")
      .run(nowIso(), invoice.id);
    ctx.db.prepare("UPDATE orders SET status = 'PAID' WHERE id = ?").run(invoice.order_id);
    closeTable(ctx, invoice.table_id);
    enqueueSync(ctx, "invoice", invoice.id, { invoiceId, status: "PAID" }, idempotencyKey("inv"));
    audit(ctx, "INVOICE_PAID", "invoice", invoice.id, null, invoice.grand_total, paid);

    if (options.printReceipt !== false) {
      void printReceipt(ctx, invoice.id);
    }

    return { ...getInvoice(ctx, invoice.id), complete: true };
  })();
}

export async function printReceipt(ctx: AppContext, invoiceId: string) {
  const snap = getInvoice(ctx, invoiceId);
  const invoice = snap.invoice as {
    invoice_number: string;
    order_id: string;
    customer_id: string | null;
    customer_display_name: string;
    customer_gstin: string;
    food_total: number;
    drinks_total: number;
    service_charge: number;
    service_charge_pct: number;
    discount: number;
    tax: number;
    other_charges: number;
    grand_total: number;
    table_id: string;
    created_at: string;
  };
  const table = getTable(ctx, invoice.table_id);
  const order = ctx.db.prepare("SELECT waiter_id FROM orders WHERE id = ?").get(invoice.order_id) as
    | { waiter_id: string | null }
    | undefined;
  let waiter = "";
  if (order?.waiter_id) {
    const staff = ctx.db.prepare("SELECT name FROM staff WHERE id = ?").get(order.waiter_id) as
      | { name: string }
      | undefined;
    waiter = staff?.name ?? "";
  }
  let guestName = "";
  if (invoice.customer_id) {
    const cust = ctx.db.prepare("SELECT name FROM customers WHERE id = ?").get(invoice.customer_id) as
      | { name: string }
      | undefined;
    guestName = cust?.name ?? "";
  }
  guestName = invoice.customer_display_name?.trim() || guestName;
  const subtotal = invoice.food_total + invoice.drinks_total;
  const discountPct = subtotal > 0 ? Math.round((invoice.discount / subtotal) * 10000) / 100 : 0;
  const unrounded =
    subtotal - invoice.discount + invoice.service_charge + invoice.tax + invoice.other_charges;
  const roundOff = invoice.grand_total - unrounded;
  const rawItems = snap.items as Array<{
    name: string;
    qty: number;
    unit_price: number;
    amount: number;
    product_id?: string;
  }>;
  const items = rawItems.map((it) => ({
    name: it.name,
    rate: it.unit_price,
    qty: it.qty,
    amount: it.amount,
  }));
  // Prefer session waiter when the order row has none.
  if (!waiter) {
    const session = ctx.db
      .prepare(
        `SELECT s.name AS waiter_name
           FROM table_sessions ts
           LEFT JOIN staff s ON s.id = ts.waiter_id
          WHERE ts.id = (SELECT session_id FROM orders WHERE id = ?)
          LIMIT 1`,
      )
      .get(invoice.order_id) as { waiter_name: string | null } | undefined;
    waiter = session?.waiter_name?.trim() || "";
  }

  const taxLines = ctx.db
    .prepare(
      `SELECT ii.amount, ii.name, ii.product_id,
              p.sales_group AS sales_group, p.tax_rate AS product_tax_rate,
              oi.tax_rate AS line_tax_rate
         FROM invoice_items ii
         LEFT JOIN products p ON p.id = ii.product_id
         LEFT JOIN order_items oi ON oi.id = ii.order_item_id
        WHERE ii.invoice_id = ?`,
    )
    .all(invoiceId) as Array<{
    amount: number;
    name: string;
    product_id: string;
    sales_group: string | null;
    product_tax_rate: number | null;
    line_tax_rate: number | null;
  }>;
  const totalLines = buildBillTotalLines({
    lines: taxLines.map((row) => ({
      amount: row.amount,
      taxRate: displayTaxRate(ctx, {
        name: row.name,
        salesGroup: row.sales_group,
        productTaxRate: row.product_tax_rate,
        lineTaxRate: row.line_tax_rate,
      }),
      salesGroup: row.sales_group,
    })),
    discount: invoice.discount,
    discountPct,
    serviceCharge: invoice.service_charge,
    serviceChargePct: invoice.service_charge_pct ?? 0,
    otherCharges: invoice.other_charges,
    roundOff,
    taxTotal: invoice.tax,
  });

  const venue = getVenueProfile(ctx);
  const payload = {
    kind: "bill" as const,
    venue,
    outlet: table.outlet || "BAR",
    billNo: invoice.invoice_number,
    tableNo: printedTableNo(ctx, { tableId: invoice.table_id, orderId: invoice.order_id }),
    waiter,
    guestName,
    guestGstin: invoice.customer_gstin ?? "",
    createdAt: invoice.created_at,
    items,
    subtotal,
    discount: invoice.discount,
    discountPct,
    tax: invoice.tax,
    serviceCharge: invoice.service_charge,
    serviceChargePct: invoice.service_charge_pct ?? 0,
    otherCharges: invoice.other_charges,
    roundOff,
    netTotal: invoice.grand_total,
    totalLines,
  };

  // HTML/CSS (Arial) matches native Windows slip. ESC/POS kept for POS_BILL_PRINT=escpos.
  // For HTML, hand the markup to the renderer. The renderer owns the Electron
  // print bridge; spawning the packaged app executable from its API child can
  // start another app instance and report success without printing anything.
  if (billPrintMode() === "escpos") {
    const result = await ctx.hardware.receipt.printReceipt(payload);
    if (!result.ok) {
      audit(ctx, "PRINTER_FAILURE", "invoice", invoiceId, result.error ?? "print failed", null, invoice.invoice_number);
    }
    return { ...result, mode: "escpos" as const, printed: Boolean(result.ok) };
  }

  const html = renderBillReceiptHtml(payload);
  return {
    ok: true,
    mode: "html" as const,
    html,
    printed: false,
  };
}

export function refundInvoice(
  ctx: AppContext,
  input: { invoiceId: string; paymentId: string; amount: number; method: "MEMBER_CARD" | "CASH" | "UPI"; reason: string },
) {
  assertPermission(ctx.actor.role, "REFUND");
  const payment = ctx.db.prepare("SELECT * FROM payments WHERE id = ? AND invoice_id = ?").get(
    input.paymentId,
    input.invoiceId,
  ) as
    | { id: string; method: string; amount: number; member_card_id: string | null; ledger_id: string | null }
    | undefined;
  if (!payment) throw new AppError("Payment not found");
  if (input.amount > payment.amount) throw new AppError("Refund exceeds payment");

  let ledgerId: string | null = null;
  if (input.method === "MEMBER_CARD") {
    if (!payment.member_card_id || !payment.ledger_id) {
      throw new AppError("Original member-card payment is required for a card refund");
    }
    getCard(ctx, payment.member_card_id);
    const result = refundToCard(ctx, {
      cardId: payment.member_card_id,
      originalLedgerId: payment.ledger_id,
      amount: input.amount,
      invoiceId: input.invoiceId,
      reason: input.reason,
    });
    ledgerId = (result.txn as { id: string }).id;
  }

  const id = uuid();
  ctx.db
    .prepare(
      `INSERT INTO refunds (id, invoice_id, payment_id, method, amount, ledger_id, staff_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.invoiceId, input.paymentId, input.method, input.amount, ledgerId, ctx.actor.staffId, input.reason, nowIso());
  ctx.db.prepare("UPDATE invoices SET status = 'REFUNDED' WHERE id = ?").run(input.invoiceId);
  audit(ctx, "REFUND", "invoice", input.invoiceId, input.reason, payment.amount, input.amount);
  return { id };
}

export function cancelInvoice(ctx: AppContext, invoiceId: string, reason: string) {
  assertPermission(ctx.actor.role, "CANCEL_INVOICE");
  const snap = getInvoice(ctx, invoiceId);
  if ((snap.invoice as { status: string }).status === "PAID") {
    throw new AppError("Paid invoices must be refunded, not cancelled");
  }
  ctx.db.prepare("UPDATE invoices SET status = 'CANCELLED' WHERE id = ?").run(invoiceId);
  audit(ctx, "INVOICE_CANCEL", "invoice", invoiceId, reason, snap.invoice, "CANCELLED");
  return getInvoice(ctx, invoiceId);
}

export function getOpenInvoiceByTable(ctx: AppContext, tableId: string) {
  const row = ctx.db
    .prepare(
      `SELECT id FROM invoices
        WHERE table_id = ? AND status IN ('UNPAID','PARTIAL')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(tableId) as { id: string } | undefined;
  if (!row) throw new AppError("No bill to settle", 404);
  return getInvoice(ctx, row.id);
}

export function listInvoices(ctx: AppContext) {
  const rows = ctx.db
    .prepare(
      `SELECT i.*, t.code AS table_code,
              COALESCE(NULLIF(t.outlet, ''), 'BAR') AS outlet_name,
              (
                SELECT c.card_number FROM member_cards c
                 WHERE c.id = COALESCE(
                   i.card_id,
                   (SELECT o.card_id FROM orders o WHERE o.id = i.order_id),
                   (SELECT s.card_id FROM table_sessions s WHERE s.id = i.session_id)
                 )
              ) AS order_card,
              cu.name AS customer_name
       FROM invoices i
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN customers cu ON cu.id = i.customer_id
       ORDER BY i.created_at DESC`,
    )
    .all() as Array<{ table_code: string; outlet_name: string; order_card: string | null }>;
  return rows.map((row) => ({
    ...row,
    table_label: formatTableNo(row.table_code, row.order_card, row.outlet_name),
  }));
}
