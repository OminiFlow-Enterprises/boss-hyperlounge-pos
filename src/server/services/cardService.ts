import { assertPermission } from "../../shared/permissions.js";
import { assertPositiveAmount } from "../../shared/money.js";
import type { Actor, BlockReason, CardBalances, LedgerType, PaymentMode } from "../../shared/types.js";
import { AppError, InsufficientBalanceError, PermissionError } from "../lib/errors.js";
import { audit, enqueueSync } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { idempotencyKey, nextNumber, nowIso, uuid } from "../lib/ids.js";
import { spendBonusFirst } from "./settingsService.js";

export interface CardRow {
  id: string;
  card_number: string;
  card_uid: string | null;
  customer_id: string;
  card_type_id: string;
  opening_paid_balance: number;
  opening_bonus_balance: number;
  paid_balance: number;
  bonus_balance: number;
  status: string;
  created_at: string;
  last_used_at: string | null;
  expiry_date: string | null;
  replaced_by_card_id: string | null;
  block_reason: string | null;
  customer_name?: string;
  mobile?: string;
  card_type_code?: string;
  card_type_name?: string;
}

export interface LedgerWrite {
  cardId: string;
  type: LedgerType;
  direction: "CREDIT" | "DEBIT";
  paidAmount: number;
  bonusAmount: number;
  paymentMode?: PaymentMode | null;
  referenceNumber?: string | null;
  relatedLedgerId?: string | null;
  relatedInvoiceId?: string | null;
  relatedCardId?: string | null;
  reason?: string | null;
  idempotencyKey: string;
}

const CARD_SELECT = `
  SELECT c.*, cu.name AS customer_name, cu.mobile, ct.code AS card_type_code, ct.name AS card_type_name
  FROM member_cards c
  JOIN customers cu ON cu.id = c.customer_id
  JOIN card_types ct ON ct.id = c.card_type_id
`;

export function getCard(ctx: AppContext, cardId: string): CardRow {
  const row = ctx.db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(cardId) as CardRow | undefined;
  if (!row) throw new AppError("Card not found", 404, "CARD_NOT_FOUND");
  return row;
}

export function searchCards(ctx: AppContext, query: string): CardRow[] {
  const q = `%${query.trim()}%`;
  return ctx.db
    .prepare(
      `${CARD_SELECT}
       WHERE c.card_number LIKE ? OR c.card_uid LIKE ? OR cu.mobile LIKE ? OR cu.name LIKE ?
       ORDER BY c.created_at DESC LIMIT 40`,
    )
    .all(q, q, q, q) as CardRow[];
}

export function findCardByScan(ctx: AppContext, cardNumber?: string, cardUid?: string): CardRow | null {
  if (cardUid) {
    const byUid = ctx.db.prepare(`${CARD_SELECT} WHERE c.card_uid = ?`).get(cardUid) as CardRow | undefined;
    if (byUid) return byUid;
  }
  if (cardNumber) {
    const byNo = ctx.db.prepare(`${CARD_SELECT} WHERE c.card_number = ?`).get(cardNumber) as CardRow | undefined;
    if (byNo) return byNo;
  }
  return null;
}

export function balancesFromLedger(ctx: AppContext, cardId: string): CardBalances {
  const row = ctx.db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='CREDIT' THEN paid_amount ELSE -paid_amount END), 0) AS paid,
         COALESCE(SUM(CASE WHEN direction='CREDIT' THEN bonus_amount ELSE -bonus_amount END), 0) AS bonus
       FROM card_ledger WHERE card_id = ?`,
    )
    .get(cardId) as { paid: number; bonus: number };
  return { paid: row.paid, bonus: row.bonus, usable: row.paid + row.bonus };
}

function refreshCachedBalance(ctx: AppContext, cardId: string): CardBalances {
  const bal = balancesFromLedger(ctx, cardId);
  ctx.db
    .prepare("UPDATE member_cards SET paid_balance = ?, bonus_balance = ? WHERE id = ?")
    .run(bal.paid, bal.bonus, cardId);
  return bal;
}

function assertUsable(card: CardRow): void {
  if (card.status === "EXPIRED" || (card.expiry_date && card.expiry_date < nowIso().slice(0, 10))) {
    throw new AppError("Card is expired", 409, "CARD_EXPIRED");
  }
  if (card.status !== "ACTIVE") {
    throw new AppError(`Card cannot be used (${card.status})`, 409, "CARD_NOT_ACTIVE");
  }
}

export function writeLedger(ctx: AppContext, input: LedgerWrite) {
  const existing = ctx.db
    .prepare("SELECT * FROM card_ledger WHERE idempotency_key = ?")
    .get(input.idempotencyKey) as Record<string, unknown> | undefined;
  if (existing) return existing;

  const card = getCard(ctx, input.cardId);
  const prev = balancesFromLedger(ctx, card.id);
  let newPaid = prev.paid;
  let newBonus = prev.bonus;
  if (input.direction === "CREDIT") {
    newPaid += input.paidAmount;
    newBonus += input.bonusAmount;
  } else {
    newPaid -= input.paidAmount;
    newBonus -= input.bonusAmount;
  }
  if (newPaid < 0 || newBonus < 0) {
    throw new AppError("Ledger write would produce a negative balance", 409, "NEGATIVE_BALANCE");
  }

  const id = nextNumber(ctx.db, "txn", "TXN-");
  const created = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO card_ledger (
         id, idempotency_key, card_id, customer_id, type, direction,
         paid_amount, bonus_amount, previous_paid, previous_bonus, new_paid, new_bonus,
         payment_mode, cashier_id, terminal_id, reference_number,
         related_ledger_id, related_invoice_id, related_card_id, reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.idempotencyKey,
      card.id,
      card.customer_id,
      input.type,
      input.direction,
      input.paidAmount,
      input.bonusAmount,
      prev.paid,
      prev.bonus,
      newPaid,
      newBonus,
      input.paymentMode ?? null,
      ctx.actor.staffId,
      ctx.actor.terminalId,
      input.referenceNumber ?? null,
      input.relatedLedgerId ?? null,
      input.relatedInvoiceId ?? null,
      input.relatedCardId ?? null,
      input.reason ?? null,
      created,
    );

  ctx.db
    .prepare("UPDATE member_cards SET paid_balance = ?, bonus_balance = ?, last_used_at = ? WHERE id = ?")
    .run(newPaid, newBonus, created, card.id);

  enqueueSync(
    ctx,
    "card_ledger",
    id,
    { ...input, id, previousPaid: prev.paid, previousBonus: prev.bonus, newPaid, newBonus },
    input.idempotencyKey,
  );

  return ctx.db.prepare("SELECT * FROM card_ledger WHERE id = ?").get(id);
}

export function createOrFindCustomer(
  ctx: AppContext,
  input: { name: string; mobile: string; email?: string; memberType?: string },
) {
  const existing = ctx.db
    .prepare("SELECT * FROM customers WHERE mobile = ?")
    .get(input.mobile.trim()) as Record<string, unknown> | undefined;
  if (existing) return existing;
  const id = uuid();
  ctx.db
    .prepare(
      "INSERT INTO customers (id, name, mobile, email, member_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      input.name.trim(),
      input.mobile.trim(),
      input.email ?? null,
      input.memberType ?? "REGULAR",
      nowIso(),
    );
  return ctx.db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
}

export function issueCard(
  ctx: AppContext,
  input: {
    customerId?: string;
    customer?: { name: string; mobile: string; email?: string };
    cardNumber?: string;
    cardUid?: string;
    cardTypeCode: string;
    openingBalance?: number;
    expiryDate?: string | null;
  },
) {
  assertPermission(ctx.actor.role, "ISSUE_CARD");
  if (!input.cardNumber && !input.cardUid) {
    throw new AppError("Enter a card number or scan a card UID");
  }

  let customerId = input.customerId;
  if (!customerId && input.customer) {
    customerId = (createOrFindCustomer(ctx, input.customer) as { id: string }).id;
  }
  if (!customerId) throw new AppError("Customer is required");

  const type = ctx.db
    .prepare("SELECT * FROM card_types WHERE code = ?")
    .get(input.cardTypeCode) as { id: string; code: string } | undefined;
  if (!type) throw new AppError("Unknown card type");

  const cardNumber = input.cardNumber?.trim() || nextNumber(ctx.db, "card", "HL-");
  if (findCardByScan(ctx, cardNumber, input.cardUid ?? undefined)) {
    throw new AppError("Card number or UID is already issued");
  }

  const opening = input.openingBalance ?? 0;
  const id = uuid();
  const created = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO member_cards (
         id, card_number, card_uid, customer_id, card_type_id,
         opening_paid_balance, opening_bonus_balance, paid_balance, bonus_balance,
         status, created_at, expiry_date
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 'ACTIVE', ?, ?)`,
    )
    .run(id, cardNumber, input.cardUid ?? null, customerId, type.id, opening, created, input.expiryDate ?? null);

  if (opening > 0) {
    writeLedger(ctx, {
      cardId: id,
      type: "ADJUSTMENT",
      direction: "CREDIT",
      paidAmount: opening,
      bonusAmount: 0,
      reason: "Opening balance",
      idempotencyKey: idempotencyKey("open"),
    });
  }

  const card = getCard(ctx, id);
  audit(ctx, "CARD_ISSUE", "member_card", id, "Activate", null, {
    cardNumber,
    customerId,
    cardType: type.code,
  });
  enqueueSync(ctx, "member_card", id, card, idempotencyKey("card"));
  return card;
}

export function applyBonusRule(ctx: AppContext, cardTypeId: string, rechargeAmount: number): number {
  const now = nowIso();
  const rules = ctx.db
    .prepare(
      `SELECT * FROM bonus_rules
       WHERE active = 1 AND min_recharge <= ?
         AND (card_type_id IS NULL OR card_type_id = ?)
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_to IS NULL OR valid_to >= ?)
       ORDER BY min_recharge DESC`,
    )
    .all(rechargeAmount, cardTypeId, now, now) as Array<{
    bonus_type: string;
    bonus_value: number;
    max_bonus: number | null;
  }>;
  if (!rules.length) return 0;
  const rule = rules[0];
  let bonus = rule.bonus_type === "PERCENT" ? Math.round((rechargeAmount * rule.bonus_value) / 100) : rule.bonus_value;
  if (rule.max_bonus != null) bonus = Math.min(bonus, rule.max_bonus);
  return bonus;
}

export function rechargeCard(
  ctx: AppContext,
  input: {
    cardId: string;
    amount: number;
    paymentMode: PaymentMode;
    referenceNumber?: string;
    printReceipt?: boolean;
    idempotencyKey?: string;
    applyBonus?: boolean;
  },
) {
  assertPermission(ctx.actor.role, "RECHARGE");
  assertPositiveAmount(input.amount, "Recharge amount");
  if (input.paymentMode === "MEMBER_CARD") {
    throw new AppError("Cannot recharge a member card using another member card");
  }

  const card = getCard(ctx, input.cardId);
  assertUsable(card);
  const key = input.idempotencyKey ?? idempotencyKey("rch");

  const result = ctx.db.transaction(() => {
    const rechargeTxn = writeLedger(ctx, {
      cardId: card.id,
      type: "RECHARGE",
      direction: "CREDIT",
      paidAmount: input.amount,
      bonusAmount: 0,
      paymentMode: input.paymentMode,
      referenceNumber: input.referenceNumber ?? null,
      idempotencyKey: key,
    });

    let bonusTxn = null;
    const shouldBonus = input.applyBonus !== false;
    const bonus = shouldBonus ? applyBonusRule(ctx, card.card_type_id, input.amount) : 0;
    if (bonus > 0) {
      bonusTxn = writeLedger(ctx, {
        cardId: card.id,
        type: "BONUS",
        direction: "CREDIT",
        paidAmount: 0,
        bonusAmount: bonus,
        relatedLedgerId: (rechargeTxn as { id: string }).id,
        reason: "Promotional bonus",
        idempotencyKey: `${key}:bonus`,
      });
    }

    const updated = getCard(ctx, card.id);
    audit(ctx, "CARD_RECHARGE", "member_card", card.id, input.paymentMode, card.paid_balance, updated.paid_balance);
    return { card: updated, recharge: rechargeTxn, bonus: bonusTxn, bonusAmount: bonus };
  })();

  if (input.printReceipt) {
    void ctx.hardware.receipt.printReceipt({
      title: "CARD RECHARGE",
      lines: [
        `Card ${result.card.card_number}`,
        `Member ${result.card.customer_name}`,
        `Previous ${formatLedgerAmount(card.paid_balance + card.bonus_balance)}`,
        `Recharge ${formatLedgerAmount(input.amount)}`,
        result.bonusAmount ? `Bonus ${formatLedgerAmount(result.bonusAmount)}` : "",
        `New ${formatLedgerAmount(result.card.paid_balance + result.card.bonus_balance)}`,
      ].filter(Boolean),
      footer: "BOSS Hyperlounge",
    });
  }

  if (input.paymentMode === "CASH") {
    void ctx.hardware.drawer.open();
  }

  return result;
}

function formatLedgerAmount(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

export function allocateSpend(ctx: AppContext, card: CardRow, amount: number): { paid: number; bonus: number } {
  const bal = balancesFromLedger(ctx, card.id);
  if (bal.usable < amount) throw new InsufficientBalanceError(amount, bal.usable);
  if (spendBonusFirst(ctx)) {
    const bonus = Math.min(bal.bonus, amount);
    return { bonus, paid: amount - bonus };
  }
  const paid = Math.min(bal.paid, amount);
  return { paid, bonus: amount - paid };
}

export function purchaseOnCard(
  ctx: AppContext,
  input: {
    cardId: string;
    amount: number;
    invoiceId: string;
    idempotencyKey?: string;
  },
) {
  assertPositiveAmount(input.amount, "Purchase amount");
  const card = getCard(ctx, input.cardId);
  assertUsable(card);
  const split = allocateSpend(ctx, card, input.amount);
  const txn = writeLedger(ctx, {
    cardId: card.id,
    type: "PURCHASE",
    direction: "DEBIT",
    paidAmount: split.paid,
    bonusAmount: split.bonus,
    paymentMode: "MEMBER_CARD",
    relatedInvoiceId: input.invoiceId,
    idempotencyKey: input.idempotencyKey ?? idempotencyKey("pay"),
  });
  audit(ctx, "CARD_PURCHASE", "member_card", card.id, input.invoiceId, card.paid_balance + card.bonus_balance, {
    debit: input.amount,
  });
  return { txn, card: getCard(ctx, card.id), split };
}

export function refundToCard(
  ctx: AppContext,
  input: {
    cardId: string;
    originalLedgerId: string;
    amount: number;
    invoiceId?: string;
    reason: string;
    idempotencyKey?: string;
  },
) {
  assertPermission(ctx.actor.role, "REFUND");
  assertPositiveAmount(input.amount, "Refund amount");
  const original = ctx.db.prepare("SELECT * FROM card_ledger WHERE id = ?").get(input.originalLedgerId) as
    | {
        id: string;
        card_id: string;
        type: string;
        direction: string;
        paid_amount: number;
        bonus_amount: number;
      }
    | undefined;
  if (!original || original.type !== "PURCHASE" || original.direction !== "DEBIT") {
    throw new AppError("Refund must reference an original card purchase");
  }
  if (original.card_id !== input.cardId) {
    throw new AppError("Refund card does not match original transaction");
  }
  const already = ctx.db
    .prepare(
      "SELECT COALESCE(SUM(paid_amount + bonus_amount), 0) AS n FROM card_ledger WHERE related_ledger_id = ? AND type = 'REFUND'",
    )
    .get(original.id) as { n: number };
  const originalTotal = original.paid_amount + original.bonus_amount;
  if (already.n + input.amount > originalTotal) {
    throw new AppError("Refund exceeds original purchase");
  }

  const paidPortion = Math.min(original.paid_amount, input.amount);
  const bonusPortion = input.amount - paidPortion;
  const txn = writeLedger(ctx, {
    cardId: input.cardId,
    type: "REFUND",
    direction: "CREDIT",
    paidAmount: paidPortion,
    bonusAmount: bonusPortion,
    relatedLedgerId: original.id,
    relatedInvoiceId: input.invoiceId ?? null,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey ?? idempotencyKey("ref"),
  });
  audit(ctx, "CARD_REFUND", "member_card", input.cardId, input.reason, originalTotal, input.amount);
  return { txn, card: getCard(ctx, input.cardId) };
}

export function swapCard(
  ctx: AppContext,
  input: {
    oldCardId: string;
    newCardNumber?: string;
    newCardUid?: string;
    reason: string;
    approverId?: string;
  },
) {
  assertPermission(ctx.actor.role, "CARD_SWAP");
  const oldCard = getCard(ctx, input.oldCardId);
  if (oldCard.status === "REPLACED") throw new AppError("Card has already been replaced");

  return ctx.db.transaction(() => {
    const bal = balancesFromLedger(ctx, oldCard.id);
    const newCard = issueCard(ctx, {
      customerId: oldCard.customer_id,
      cardNumber: input.newCardNumber,
      cardUid: input.newCardUid,
      cardTypeCode: oldCard.card_type_code ?? "REGULAR",
      expiryDate: oldCard.expiry_date,
    });

    const key = idempotencyKey("swap");
    if (bal.usable > 0) {
      writeLedger(ctx, {
        cardId: oldCard.id,
        type: "CARD_SWAP",
        direction: "DEBIT",
        paidAmount: bal.paid,
        bonusAmount: bal.bonus,
        relatedCardId: newCard.id,
        reason: input.reason,
        idempotencyKey: `${key}:out`,
      });
      writeLedger(ctx, {
        cardId: newCard.id,
        type: "CARD_SWAP",
        direction: "CREDIT",
        paidAmount: bal.paid,
        bonusAmount: bal.bonus,
        relatedCardId: oldCard.id,
        reason: input.reason,
        idempotencyKey: `${key}:in`,
      });
    }

    ctx.db
      .prepare(
        "UPDATE member_cards SET status = 'REPLACED', block_reason = ?, replaced_by_card_id = ? WHERE id = ?",
      )
      .run("Replaced", newCard.id, oldCard.id);

    const swapId = uuid();
    ctx.db
      .prepare(
        `INSERT INTO card_swaps
          (id, old_card_id, new_card_id, transferred_paid, transferred_bonus, reason, staff_id, approver_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        swapId,
        oldCard.id,
        newCard.id,
        bal.paid,
        bal.bonus,
        input.reason,
        ctx.actor.staffId,
        input.approverId ?? ctx.actor.staffId,
        nowIso(),
      );

    audit(ctx, "CARD_SWAP", "member_card", oldCard.id, input.reason, { old: oldCard.id, bal }, {
      new: newCard.id,
      transferred: bal,
    });

    return {
      swapId,
      oldCard: getCard(ctx, oldCard.id),
      newCard: getCard(ctx, newCard.id),
      transferred: bal,
    };
  })();
}

export function blockCard(ctx: AppContext, cardId: string, reason: BlockReason) {
  assertPermission(ctx.actor.role, "CARD_BLOCK");
  const card = getCard(ctx, cardId);
  const status = reason === "Lost" ? "LOST" : "BLOCKED";
  ctx.db.prepare("UPDATE member_cards SET status = ?, block_reason = ? WHERE id = ?").run(status, reason, cardId);
  audit(ctx, "CARD_BLOCK", "member_card", cardId, reason, card.status, status);
  return getCard(ctx, cardId);
}

export function unblockCard(ctx: AppContext, cardId: string, reason: string) {
  assertPermission(ctx.actor.role, "CARD_UNBLOCK");
  const card = getCard(ctx, cardId);
  if (card.status === "REPLACED") throw new AppError("Replaced cards cannot be unblocked");
  if (card.status === "EXPIRED") throw new AppError("Expired cards cannot be unblocked");
  ctx.db.prepare("UPDATE member_cards SET status = 'ACTIVE', block_reason = NULL WHERE id = ?").run(cardId);
  audit(ctx, "CARD_UNBLOCK", "member_card", cardId, reason, card.status, "ACTIVE");
  return getCard(ctx, cardId);
}

export function checkBalance(ctx: AppContext, query: string) {
  const matches = searchCards(ctx, query);
  if (!matches.length) throw new AppError("Card not found", 404, "CARD_NOT_FOUND");
  const card = matches[0];
  const last = ctx.db
    .prepare("SELECT * FROM card_ledger WHERE card_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(card.id);
  const ledger = balancesFromLedger(ctx, card.id);
  return { card: { ...card, ...{ paid_balance: ledger.paid, bonus_balance: ledger.bonus } }, last, balances: ledger };
}

export function cardLedger(
  ctx: AppContext,
  filters: { cardId?: string; customerId?: string; type?: LedgerType; from?: string; to?: string },
) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.cardId) {
    clauses.push("l.card_id = ?");
    params.push(filters.cardId);
  }
  if (filters.customerId) {
    clauses.push("l.customer_id = ?");
    params.push(filters.customerId);
  }
  if (filters.type) {
    clauses.push("l.type = ?");
    params.push(filters.type);
  }
  if (filters.from) {
    clauses.push("l.created_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("l.created_at <= ?");
    params.push(filters.to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return ctx.db
    .prepare(
      `SELECT l.*, c.card_number, cu.name AS customer_name
       FROM card_ledger l
       JOIN member_cards c ON c.id = l.card_id
       JOIN customers cu ON cu.id = l.customer_id
       ${where}
       ORDER BY l.created_at ASC`,
    )
    .all(...params);
}

export function listCards(ctx: AppContext, status?: string) {
  if (status) return ctx.db.prepare(`${CARD_SELECT} WHERE c.status = ? ORDER BY c.created_at DESC`).all(status);
  return ctx.db.prepare(`${CARD_SELECT} ORDER BY c.created_at DESC`).all();
}

export function requireManagerApproval(_actor: Actor, _approverId?: string) {
  return true;
}

export { PermissionError };
