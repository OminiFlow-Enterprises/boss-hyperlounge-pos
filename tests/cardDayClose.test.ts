import { afterEach, expect, it, vi } from "vitest";
import { balancesFromLedger, expireStaleCardBalances, issueCard, rechargeCard, writeLedger } from "../src/server/services/cardService.js";
import { saveBooking } from "../src/server/services/reportService.js";
import { createTestApp } from "./helpers.js";

afterEach(() => vi.useRealTimers());

it("expires paid and bonus balances at 6 AM IST and charges the fee only once per card per day", () => {
  const { db, ctx } = createTestApp();
  const cashier = ctx();
  try {
    vi.setSystemTime(new Date("2026-11-24T05:58:00+05:30"));
    const card = issueCard(cashier, {
      cardNumber: "0042", cardTypeCode: "REGULAR", customer: { name: "Guest", mobile: "card-0042" },
    });
    const recharge = (amount: number) => rechargeCard(cashier, {
      cardId: card.id, amount, paymentMode: "UPI", applyBonus: false,
    });
    expect(recharge(50_000).fee).toBe(10_000);
    expect(recharge(5_000).fee).toBe(0);
    writeLedger(cashier, {
      cardId: card.id, type: "BONUS", direction: "CREDIT", paidAmount: 0, bonusAmount: 5_000,
      idempotencyKey: "day-close-test-bonus",
    });
    vi.setSystemTime(new Date("2026-11-24T05:59:59.999+05:30"));
    expireStaleCardBalances({ db });
    expect(balancesFromLedger(cashier, card.id).usable).toBe(50_000);

    vi.setSystemTime(new Date("2026-11-24T06:00:00+05:30"));
    expireStaleCardBalances({ db });
    expireStaleCardBalances({ db });
    expect(balancesFromLedger(cashier, card.id).usable).toBe(0);
    expect(recharge(50_000).fee).toBe(10_000);
    expect(recharge(5_000).fee).toBe(0);
    expect(balancesFromLedger(cashier, card.id).usable).toBe(45_000);
    expect(db.prepare("SELECT COUNT(*) FROM card_ledger WHERE type = 'EXPIRY'").pluck().get()).toBe(1);
  } finally {
    db.close();
  }
});

it("adds to the same advance card and subtracts an authorized negative entry exactly", () => {
  const { db, ctx } = createTestApp();
  const entry = { cardNo: "0042", guestName: "Guest", mop: "CASH" };
  try {
    expect(saveBooking(ctx(), { ...entry, advance: 50_000 }).balances.paid).toBe(40_000);
    expect(saveBooking(ctx(), { ...entry, advance: 5_000 }).balances.paid).toBe(45_000);
    expect(() => saveBooking(ctx(), { ...entry, advance: -1_234 })).toThrow(/permission denied/i);
    expect(() => saveBooking(ctx("owner"), { ...entry, advance: -50_000 })).toThrow(/insufficient/i);
    expect(() => saveBooking(ctx("owner"), { cardNo: "0043", advance: -1_234 })).toThrow(/card not found/i);
    const debit = saveBooking(ctx("owner"), { ...entry, advance: -1_234 });
    expect(debit.balances.paid).toBe(43_766);
    expect(debit.advance).toBe(-1_234);
    expect(db.prepare("SELECT type, direction, paid_amount FROM card_ledger WHERE idempotency_key = ?")
      .get(`adv:${debit.id}`)).toEqual({ type: "ADJUSTMENT", direction: "DEBIT", paid_amount: 1_234 });
    expect(db.prepare("SELECT COUNT(*) FROM bookings").pluck().get()).toBe(3);
  } finally {
    db.close();
  }
});
