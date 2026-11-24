import { afterEach, expect, it, vi } from "vitest";
import { syncErpPayments } from "../src/server/services/erpPaymentSync.js";
import { createTestApp } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

it("credits cloud payments once across lost acknowledgements and applies corrections atomically", async () => {
  const { db, ctx } = createTestApp();
  const acknowledgements: Record<string, unknown>[] = [];
  let updates: object[] = [];
  let failedAck = false;
  vi.stubGlobal("fetch", async (url: URL, options: RequestInit) => {
    switch (url.searchParams.get("route")) {
      case "erp-sync-pending":
        return Response.json({
          ok: true,
          entries: [
            { id: 1, card_no: "2026-11-24-42", amount: "1,000.00", local_erp_amount: "900.00", payment_mode: "PAYTM" },
            { id: 2, card_no: 42, amount: 100, local_erp_amount: 0, payment_mode: "HO CASH" },
            { id: 3, card_no: "invalid", amount: 500 },
          ],
        });
      case "erp-sync-updates-pending":
        return Response.json({ ok: true, entries: updates });
      default: {
        const body = JSON.parse(String(options.body));
        acknowledgements.push(body);
        if (body.id === 1 && !failedAck) {
          failedAck = true;
          return new Response(null, { status: 503 });
        }
        return Response.json({ ok: true });
      }
    }
  });
  const sync = () => syncErpPayments(ctx(), new URL("https://erp.invalid/api"), "mock", 25, 500);
  const balance = () => db.prepare("SELECT paid_balance FROM member_cards WHERE card_number = '0042'").pluck().get();

  try {
    await sync();
    const bookingNo = acknowledgements.find(({ id }) => id === 1)!.booking_no;
    expect(balance()).toBe(100_000);
    expect(db.prepare("SELECT mop FROM bookings WHERE id = 'erp-sync:1'").pluck().get())
      .toBe("BANK TRANSFER / PAYTM");
    expect(acknowledgements).toContainEqual(expect.objectContaining({ id: 3, success: false }));

    updates = [{ id: 4, erp_booking_no: bookingNo, local_erp_amount: 800, payment_mode: "HDFC" }];
    await sync();
    await sync();
    expect(balance()).toBe(90_000);
    expect(acknowledgements.filter(({ id }) => id === 1)).toEqual([
      { id: 1, success: true, booking_no: bookingNo },
      { id: 1, success: true, booking_no: bookingNo },
      { id: 1, success: true, booking_no: bookingNo },
    ]);
    expect(db.prepare("SELECT advance, mop FROM bookings ORDER BY reservation_no").all()).toEqual([
      { advance: 80_000, mop: "BANK TRANSFER / HDFC" },
      { advance: 10_000, mop: "CASH" },
    ]);
    expect(db.prepare("SELECT type, direction, paid_amount FROM card_ledger ORDER BY rowid").all()).toEqual([
      { type: "RECHARGE", direction: "CREDIT", paid_amount: 90_000 },
      { type: "RECHARGE", direction: "CREDIT", paid_amount: 10_000 },
      { type: "ADJUSTMENT", direction: "DEBIT", paid_amount: 10_000 },
    ]);
  } finally {
    db.close();
  }
});

it("uses POS account names for live aliases and rejects an unmapped mode", async () => {
  const { db, ctx } = createTestApp();
  const acknowledgements: Array<{ id: number; success: boolean }> = [];
  const modes = ["BOOKMYSHOW", "EAZYDINER", "SWIGGY", "MOBIKWIK", "HO_CASH", "UNKNOWN"];
  vi.stubGlobal("fetch", async (url: URL, options: RequestInit) => {
    if (url.searchParams.get("route") === "erp-sync-pending") {
      return Response.json({
        ok: true,
        entries: modes.map((payment_mode, id) => ({
          id, payment_mode, card_no: "0042", amount: 500,
          save_booking: { PaymentMode: payment_mode === "MOBIKWIK" ? "CASH" : payment_mode },
        })),
      });
    }
    if (options.body) acknowledgements.push(JSON.parse(String(options.body)));
    return Response.json({ ok: true });
  });
  try {
    await syncErpPayments(ctx(), new URL("https://erp.invalid/api"), "mock", 25, 500);
    expect(db.prepare("SELECT mop FROM bookings ORDER BY reservation_no").pluck().all()).toEqual([
      "BANK TRANSFER / BOOK MY SHOW", "BANK TRANSFER / EAZYDINNER", "BANK TRANSFER / SWIGGY",
      "BANK TRANSFER / MOBIKWIK", "CASH",
    ]);
    expect(acknowledgements.at(-1)).toMatchObject({ id: 5, success: false });
  } finally {
    db.close();
  }
});
