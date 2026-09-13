import { assertPermission } from "../../shared/permissions.js";
import { formatINR } from "../../shared/money.js";
import { AppError, InsufficientBalanceError } from "../lib/errors.js";
import { audit, enqueueSync } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { idempotencyKey, nextNumber, nowIso, uuid } from "../lib/ids.js";
import type { PaymentLine, ServiceChargeMode } from "../../shared/types.js";
import { purchaseOnCard, refundToCard, getCard } from "./cardService.js";
import { closeTable, getTable, setTableStatus } from "./tableService.js";
import { getServiceCharge } from "./settingsService.js";

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
    name: string;
    station: string;
    qty: number;
    unit_price: number;
    amount: number;
  }>;
}

export function previewBill(
  ctx: AppContext,
  orderId: string,
  options: { discount?: number; otherCharges?: number; serviceChargePct?: number; serviceChargeMode?: ServiceChargeMode } = {},
): BillPreview {
  const order = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as
    | { id: string; session_id: string; table_id: string }
    | undefined;
  if (!order) throw new AppError("Order not found", 404);
  const table = getTable(ctx, order.table_id);
  const items = ctx.db
    .prepare("SELECT * FROM order_items WHERE order_id = ? AND voided = 0")
    .all(orderId) as Array<{
    id: string;
    name: string;
    station: string;
    qty: number;
    unit_price: number;
    tax_rate: number;
  }>;
  if (!items.length) throw new AppError("Bill has no items");

  const mapped = items.map((i) => ({
    id: i.id,
    name: i.name,
    station: i.station,
    qty: i.qty,
    unit_price: i.unit_price,
    amount: i.qty * i.unit_price,
    tax_rate: i.tax_rate,
  }));
  const foodTotal = mapped.filter((i) => i.station === "KITCHEN").reduce((s, i) => s + i.amount, 0);
  const drinksTotal = mapped.filter((i) => i.station === "BAR").reduce((s, i) => s + i.amount, 0);
  const subtotal = foodTotal + drinksTotal;
  const tax = mapped.reduce((s, i) => s + Math.round(i.amount * (i.tax_rate / 100)), 0);
  const configured = getServiceCharge(ctx);
  const pct = options.serviceChargePct ?? configured.pct;
  const mode = options.serviceChargeMode ?? configured.mode;
  const discount = options.discount ?? 0;
  const otherCharges = options.otherCharges ?? 0;
  const afterDiscount = Math.max(0, subtotal - discount);
  const serviceCharge =
    mode === "INCLUSIVE" ? Math.round(afterDiscount - afterDiscount / (1 + pct / 100)) : Math.round((afterDiscount * pct) / 100);
  const grandTotal =
    mode === "INCLUSIVE" ? afterDiscount + tax + otherCharges : afterDiscount + serviceCharge + tax + otherCharges;

  return {
    orderId: order.id,
    sessionId: order.session_id,
    tableId: order.table_id,
    tableCode: table.code,
    foodTotal,
    drinksTotal,
    tax,
    serviceCharge,
    serviceChargePct: pct,
    serviceChargeMode: mode,
    discount,
    otherCharges,
    grandTotal,
    items: mapped,
  };
}

export function generateInvoice(
  ctx: AppContext,
  orderId: string,
  options: { discount?: number; otherCharges?: number; serviceChargePct?: number; reason?: string } = {},
) {
  assertPermission(ctx.actor.role, "SETTLE_BILL");
  if ((options.discount ?? 0) > 0) {
    const preview = previewBill(ctx, orderId, options);
    if (options.discount! > preview.foodTotal + preview.drinksTotal * 0.2) {
      assertPermission(ctx.actor.role, "LARGE_DISCOUNT");
    }
    audit(ctx, "DISCOUNT", "order", orderId, options.reason ?? "discount", 0, options.discount);
  }
  if (options.serviceChargePct != null) {
    assertPermission(ctx.actor.role, "SERVICE_CHARGE_OVERRIDE");
  }

  const existing = ctx.db
    .prepare("SELECT * FROM invoices WHERE order_id = ? AND status IN ('UNPAID','PARTIAL')")
    .get(orderId);
  if (existing) return existing;

  const bill = previewBill(ctx, orderId, options);
  const order = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as {
    customer_id: string | null;
    card_id: string | null;
  };
  const id = uuid();
  const invoiceNumber = nextNumber(ctx.db, "invoice", "INV-");
  ctx.db
    .prepare(
      `INSERT INTO invoices (
         id, invoice_number, session_id, order_id, table_id, customer_id, card_id,
         food_total, drinks_total, service_charge, service_charge_mode, service_charge_pct,
         discount, tax, other_charges, grand_total, status, cashier_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNPAID', ?, ?)`,
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
      ctx.actor.staffId,
      nowIso(),
    );
  for (const item of bill.items) {
    ctx.db
      .prepare(
        `INSERT INTO invoice_items (id, invoice_id, order_item_id, product_id, name, station, qty, unit_price, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuid(),
        id,
        item.id,
        (ctx.db.prepare("SELECT product_id FROM order_items WHERE id = ?").get(item.id) as { product_id: string }).product_id,
        item.name,
        item.station,
        item.qty,
        item.unit_price,
        item.amount,
      );
  }
  ctx.db.prepare("UPDATE orders SET status = 'SETTLING' WHERE id = ?").run(orderId);
  setTableStatus(ctx, bill.tableId, "PAYMENT_PENDING");
  return ctx.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
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

    let paid = snap.paid;
    const created = [];
    for (const line of lines) {
      if (line.amount <= 0) throw new AppError("Payment amount must be positive");
      let ledgerId: string | null = null;
      if (line.method === "MEMBER_CARD") {
        const cardId = line.memberCardId ?? invoice.card_id;
        if (!cardId) throw new AppError("Member card is required for card payment");
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
      const paymentId = uuid();
      ctx.db
        .prepare(
          `INSERT INTO payments (id, invoice_id, method, amount, member_card_id, ledger_id, reference, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          paymentId,
          invoice.id,
          line.method,
          line.amount,
          line.memberCardId ?? invoice.card_id ?? null,
          ledgerId,
          line.reference ?? null,
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
    food_total: number;
    drinks_total: number;
    service_charge: number;
    discount: number;
    tax: number;
    other_charges: number;
    grand_total: number;
    table_id: string;
  };
  const table = getTable(ctx, invoice.table_id);
  const lines = [
    `Invoice ${invoice.invoice_number}`,
    `Table ${table.code}`,
    `Food ${formatINR(invoice.food_total)}`,
    `Drinks ${formatINR(invoice.drinks_total)}`,
    invoice.discount ? `Discount ${formatINR(invoice.discount)}` : "",
    `Service ${formatINR(invoice.service_charge)}`,
    invoice.tax ? `Tax ${formatINR(invoice.tax)}` : "",
    invoice.other_charges ? `Other ${formatINR(invoice.other_charges)}` : "",
    `TOTAL ${formatINR(invoice.grand_total)}`,
    ...snap.payments.map((p) => {
      const pay = p as unknown as { method: string; amount: number };
      return `${pay.method} ${formatINR(pay.amount)}`;
    }),
  ].filter(Boolean);
  const result = await ctx.hardware.receipt.printReceipt({
    title: "BOSS HYPERLOUNGE",
    lines,
    footer: "Thank you. Drive safe.",
  });
  if (!result.ok) {
    audit(ctx, "PRINTER_FAILURE", "invoice", invoiceId, result.error ?? "print failed", null, invoice.invoice_number);
  }
  return result;
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

export function listInvoices(ctx: AppContext) {
  return ctx.db
    .prepare(
      `SELECT i.*, t.code AS table_code, cu.name AS customer_name
       FROM invoices i
       JOIN dining_tables t ON t.id = i.table_id
       LEFT JOIN customers cu ON cu.id = i.customer_id
       ORDER BY i.created_at DESC`,
    )
    .all();
}
