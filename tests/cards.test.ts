import { describe, expect, it } from "vitest";
import { rupeesToPaise } from "../src/shared/money.js";
import {
  issueCard,
  rechargeCard,
  swapCard,
  blockCard,
  unblockCard,
  purchaseOnCard,
  refundToCard,
  balancesFromLedger,
  checkBalance,
  expireOvernightBalance,
} from "../src/server/services/cardService.js";
import { saveBooking } from "../src/server/services/reportService.js";
import { businessDayStart } from "../src/server/lib/ids.js";
import { InsufficientBalanceError } from "../src/server/lib/errors.js";
import { createTestApp } from "./helpers.js";

describe("member cards", () => {
  it("never updates a balance without a ledger row", () => {
    const { ctx } = createTestApp();
    const cashier = ctx("cashier");
    const card = issueCard(cashier, {
      customer: { name: "Mira Shah", mobile: "9000000001" },
      cardNumber: "HL-2001",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(1250), paymentMode: "UPI" });
    const ledger = balancesFromLedger(cashier, card.id);
    expect(ledger.paid).toBe(rupeesToPaise(1250));
    expect(card.paid_balance).toBe(0);
  });

  it("applies promotional bonus separately from paid balance", () => {
    const { ctx } = createTestApp();
    const cashier = ctx("cashier");
    const card = issueCard(cashier, {
      customer: { name: "VIP Guest", mobile: "9000000002" },
      cardNumber: "HL-2002",
      cardTypeCode: "MEMBER",
    });
    const result = rechargeCard(cashier, {
      cardId: card.id,
      amount: rupeesToPaise(5000),
      paymentMode: "CASH",
    });
    expect(result.bonusAmount).toBe(rupeesToPaise(500));
    expect(result.card.paid_balance).toBe(rupeesToPaise(5000));
    expect(result.card.bonus_balance).toBe(rupeesToPaise(500));
    expect(result.card.paid_balance + result.card.bonus_balance).toBe(rupeesToPaise(5500));
  });

  it("blocks spend on a blocked card and allows unblock", () => {
    const { ctx } = createTestApp();
    const manager = ctx("manager");
    const cashier = ctx("cashier");
    const card = issueCard(cashier, {
      customer: { name: "Lost Card", mobile: "9000000003" },
      cardNumber: "HL-2003",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(1000), paymentMode: "CASH" });
    blockCard(manager, card.id, "Lost");
    expect(() =>
      purchaseOnCard(cashier, { cardId: card.id, amount: rupeesToPaise(100), invoiceId: "inv" }),
    ).toThrow(/cannot be used/);
    unblockCard(manager, card.id, "Found");
    purchaseOnCard(cashier, { cardId: card.id, amount: rupeesToPaise(100), invoiceId: "inv" });
    expect(balancesFromLedger(cashier, card.id).usable).toBe(rupeesToPaise(900));
  });

  it("swaps balance onto a new card and kills the old one", () => {
    const { ctx } = createTestApp();
    const manager = ctx("manager");
    const cashier = ctx("cashier");
    const oldCard = issueCard(cashier, {
      customer: { name: "Swap Guest", mobile: "9000000004" },
      cardNumber: "HL-2004",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: oldCard.id, amount: rupeesToPaise(3250), paymentMode: "CASH" });
    const swap = swapCard(manager, {
      oldCardId: oldCard.id,
      newCardNumber: "HL-2004-NEW",
      reason: "Damaged",
    });
    expect(swap.oldCard.status).toBe("REPLACED");
    expect(swap.transferred.usable).toBe(rupeesToPaise(3250));
    expect(balancesFromLedger(cashier, swap.oldCard.id).usable).toBe(0);
    expect(balancesFromLedger(cashier, swap.newCard.id).usable).toBe(rupeesToPaise(3250));
    expect(() =>
      purchaseOnCard(cashier, { cardId: swap.oldCard.id, amount: 100, invoiceId: "x" }),
    ).toThrow(/cannot be used/);
  });

  it("shows insufficient card balance with shortfall", () => {
    const { ctx } = createTestApp();
    const cashier = ctx("cashier");
    const card = issueCard(cashier, {
      customer: { name: "Short", mobile: "9000000005" },
      cardNumber: "HL-2005",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(1200), paymentMode: "CASH" });
    try {
      purchaseOnCard(cashier, { cardId: card.id, amount: rupeesToPaise(2850), invoiceId: "inv" });
      throw new Error("expected insufficient");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientBalanceError);
      expect((err as InsufficientBalanceError).details).toEqual({
        required: rupeesToPaise(2850),
        available: rupeesToPaise(1200),
        shortfall: rupeesToPaise(1650),
      });
    }
  });

  it("refunds only against an original purchase", () => {
    const { ctx } = createTestApp();
    const manager = ctx("manager");
    const cashier = ctx("cashier");
    const card = issueCard(cashier, {
      customer: { name: "Refund", mobile: "9000000006" },
      cardNumber: "HL-2006",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(2000), paymentMode: "CASH" });
    const buy = purchaseOnCard(cashier, { cardId: card.id, amount: rupeesToPaise(500), invoiceId: "inv" });
    refundToCard(manager, {
      cardId: card.id,
      originalLedgerId: (buy.txn as { id: string }).id,
      amount: rupeesToPaise(500),
      reason: "Kitchen void",
    });
    expect(balancesFromLedger(cashier, card.id).usable).toBe(rupeesToPaise(2000));
    expect(() =>
      refundToCard(manager, {
        cardId: card.id,
        originalLedgerId: (buy.txn as { id: string }).id,
        amount: rupeesToPaise(100),
        reason: "again",
      }),
    ).toThrow(/exceeds original/);
  });

  it("checks balance quickly by mobile", () => {
    const { ctx } = createTestApp();
    const cashier = ctx("cashier");
    const card = issueCard(cashier, {
      customer: { name: "Front Desk", mobile: "9000000099" },
      cardNumber: "HL-2099",
      cardTypeCode: "VIP",
    });
    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(100), paymentMode: "CASH", applyBonus: false });
    const check = checkBalance(cashier, "9000000099");
    expect(check.card.card_number).toBe("HL-2099");
    expect(check.balances.usable).toBe(rupeesToPaise(100));
  });

  it("credits advance booking onto the card so billing can show the balance", () => {
    const { ctx } = createTestApp();
    const cashier = ctx("cashier");
    const saved = saveBooking(cashier, {
      guestName: "Aman",
      mobile: "9876500001",
      cardNo: "C1001",
      advance: rupeesToPaise(1001),
      mop: "CASH",
    }) as { balances: { usable: number } };
    expect(saved.balances.usable).toBe(rupeesToPaise(1001));
    const check = checkBalance(cashier, "C1001");
    expect(check.card.card_number).toBe("C1001");
    expect(check.balances.usable).toBe(rupeesToPaise(1001));
  });

  it("lapses unused balance at 6 AM until the card is recharged again", () => {
    const { ctx, db } = createTestApp();
    const cashier = ctx("cashier");
    const card = issueCard(cashier, {
      customer: { name: "Night Guest", mobile: "9000000888" },
      cardNumber: "NIGHT-1",
      cardTypeCode: "REGULAR",
    });
    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(1001), paymentMode: "CASH", applyBonus: false });
    const beforeCutoff = new Date(businessDayStart().getTime() - 60 * 60 * 1000);
    db.prepare("UPDATE card_ledger SET created_at = ? WHERE card_id = ?").run(beforeCutoff.toISOString(), card.id);

    const check = checkBalance(cashier, "NIGHT-1");
    expect(check.balances.usable).toBe(0);
    expect(() =>
      purchaseOnCard(cashier, { cardId: card.id, amount: rupeesToPaise(100), invoiceId: "inv" }),
    ).toThrow(InsufficientBalanceError);

    rechargeCard(cashier, { cardId: card.id, amount: rupeesToPaise(500), paymentMode: "CASH", applyBonus: false });
    expect(checkBalance(cashier, "NIGHT-1").balances.usable).toBe(rupeesToPaise(500));
    expect(expireOvernightBalance(cashier, card.id).usable).toBe(rupeesToPaise(500));
  });
});
