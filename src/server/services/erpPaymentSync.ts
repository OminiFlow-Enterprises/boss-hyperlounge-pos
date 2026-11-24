import fs from "node:fs";
import type { Actor, PaymentMode } from "../../shared/types.js";
import { BANK_PAYMENT_ACCOUNTS } from "../../shared/paymentAccounts.js";
import { audit } from "../lib/audit.js";
import type { AppContext } from "../lib/context.js";
import { businessDayStart, idempotencyKey } from "../lib/ids.js";
import * as cards from "./cardService.js";

const prefix = "erp-sync:";

type Entry = {
  id?: string | number;
  card_no?: string | number;
  erp_reference?: string;
  customer_name?: string;
  amount?: string | number;
  local_erp_amount?: string | number;
  amount_deduction_applied?: boolean;
  skip_amount_deduction?: boolean;
  erp_payment_mode?: string;
  payment_mode?: string;
  erp_booking_no?: string | number;
  booking_no?: string | number;
  save_booking?: {
    OtherRefrence?: string;
    GuestName?: string;
    NetAmount?: string | number;
    AdvanceAmount?: string | number;
    PaymentMode?: string;
  };
};

type Booking = { id: string; reservation_no: number; advance: number; mop: string; created_at: string };

function money(value: unknown) {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  const paise = Math.round(Number(raw) * 100);
  if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isSafeInteger(paise)) {
    throw new Error("Invalid payment amount");
  }
  return paise;
}

function creditAmount(entry: Entry, fallbackDeduction: number, updating: boolean) {
  const net = entry.local_erp_amount == null ? undefined : money(entry.local_erp_amount);
  if (net !== undefined && (net > 0 || updating)) return net;

  const gross = money(entry.amount ?? entry.save_booking?.NetAmount ?? entry.save_booking?.AdvanceAmount);
  const skip = entry.amount_deduction_applied === false || entry.skip_amount_deduction === true;
  const deduction = skip ? 0 : entry.amount_deduction_applied === true || updating ? 10_000 : fallbackDeduction;
  return Math.max(0, gross - deduction);
}

function modeKey(value: string) {
  return value.trim().toUpperCase().replace(/^\d+\s+/, "").replace(/[^A-Z0-9]/g, "");
}

function paymentMode(entry: Entry, fallback = "CASH"): { mop: string; mode: PaymentMode } {
  const source = entry.payment_mode?.trim() || entry.erp_payment_mode?.trim() ||
    entry.save_booking?.PaymentMode?.trim() || fallback;
  const accountName = source.replace(/^\s*(?:bank\s*transfer|card|upi)\s*\/\s*/i, "");
  const key = modeKey(accountName);
  if (key === "CASH" || key === "HOCASH") return { mop: "CASH", mode: "CASH" };
  if (["BANKTRANSFER", "CARD", "UPI", "ONLINE"].includes(key)) {
    return { mop: "BANK TRANSFER / Bank payment", mode: "CARD" };
  }
  const accountKey = key === "EAZYDINER" ? "EAZYDINNER" : key;
  const account = BANK_PAYMENT_ACCOUNTS.find((name) => modeKey(name) === accountKey);
  if (!account) throw new Error(`Unmapped server payment mode: ${source}`);
  return { mop: `BANK TRANSFER / ${account}`, mode: "CARD" };
}

function createBooking(ctx: AppContext, entry: Entry, entryId: string) {
  const id = prefix + entryId;
  const existing = ctx.db.prepare("SELECT reservation_no FROM bookings WHERE id = ?").get(id) as Booking | undefined;
  if (existing) return `POS-${existing.reservation_no}`;

  const cardNo = String(entry.save_booking?.OtherRefrence || entry.card_no || entry.erp_reference || "")
    .replace(/\s+/g, "").replace(/^\d{4}-\d{2}-\d{2}-/, "").padStart(4, "0");
  if (!/^\d{4}$/.test(cardNo) || cardNo === "0000") throw new Error("Invalid payment card number");
  const guestName = String(entry.save_booking?.GuestName || entry.customer_name || "").trim();
  const { mop, mode } = paymentMode(entry);
  const card = cards.findCardByScan(ctx, cardNo) ?? cards.issueCard(ctx, {
    cardNumber: cardNo,
    cardTypeCode: "REGULAR",
    customer: { name: guestName || "Guest", mobile: `card-${cardNo}` },
  });
  cards.assertUsable(card);
  const now = new Date();
  const fee = cards.cardRechargeFee(ctx, card.id, now);
  const gross = entry.amount == null ? undefined : money(entry.amount);
  const amount = gross == null ? creditAmount(entry, fee, false) : gross - fee;
  if (amount < 0 || (gross ?? amount) <= 0) throw new Error("Payment does not cover the recharge fee");
  cards.expireOvernightBalance(ctx, card.id, now);
  const row = ctx.db.prepare("SELECT COALESCE(MAX(reservation_no), 429) + 1 AS number FROM bookings")
    .get() as { number: number };
  ctx.db.prepare(
    "INSERT INTO bookings (id, reservation_no, guest_name, card_no, advance, mop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, row.number, guestName, cardNo, amount, mop, now.toISOString());
  cards.writeLedger(ctx, {
    cardId: card.id, type: "RECHARGE", direction: "CREDIT", paidAmount: amount, bonusAmount: 0,
    paymentMode: mode, referenceNumber: mop.split(" / ")[1] ?? entryId,
    reason: "Server payment", idempotencyKey: `adv:${id}`,
  });
  audit(ctx, "ERP_PAYMENT_SYNC", "booking", id, "Server payment", null, { amount, mop });
  return `POS-${row.number}`;
}

function updateBooking(ctx: AppContext, entry: Entry) {
  const match = /^POS-(\d+)$/.exec(String(entry.erp_booking_no ?? entry.booking_no ?? ""));
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Payment was not booked by this POS");
  const booking = ctx.db.prepare("SELECT * FROM bookings WHERE reservation_no = ? AND id LIKE 'erp-sync:%'")
    .get(Number(match[1])) as Booking | undefined;
  if (!booking) throw new Error("Server payment booking not found");
  const suppliedAmount = entry.local_erp_amount ?? entry.amount ?? entry.save_booking?.NetAmount ?? entry.save_booking?.AdvanceAmount;
  const amount = suppliedAmount == null ? booking.advance : creditAmount(entry, 0, true);
  const { mop, mode } = paymentMode(entry, booking.mop);
  const delta = amount - booking.advance;
  if (!delta && mop === booking.mop) return;

  const credit = ctx.db.prepare("SELECT id, card_id FROM card_ledger WHERE idempotency_key = ?")
    .get(`adv:${booking.id}`) as { id: string; card_id: string } | undefined;
  if (!credit) throw new Error("Original card credit not found");
  if (delta) {
    if (booking.created_at < businessDayStart().toISOString()) {
      throw new Error("Amount correction requires reconciliation after business-day close");
    }
    cards.assertUsable(cards.getCard(ctx, credit.card_id));
    cards.expireOvernightBalance(ctx, credit.card_id);
    cards.writeLedger(ctx, {
      cardId: credit.card_id, type: "ADJUSTMENT", direction: delta > 0 ? "CREDIT" : "DEBIT",
      paidAmount: Math.abs(delta), bonusAmount: 0, paymentMode: mode, relatedLedgerId: credit.id,
      reason: "Server payment correction", idempotencyKey: idempotencyKey("erp-edit"),
    });
  }
  ctx.db.prepare("UPDATE bookings SET advance = ?, mop = ? WHERE id = ?").run(amount, mop, booking.id);
  audit(ctx, "ERP_PAYMENT_UPDATE", "booking", booking.id, "Server payment correction",
    { amount: booking.advance, mop: booking.mop }, { amount, mop });
}

type Config = {
  cloud_api_base: string;
  api_key: string;
  poll_interval_seconds?: number;
  batch_size?: number;
  fetch_timeout_ms?: number;
  pos_staff_username?: string;
  pos_terminal_name?: string;
};

export function startErpPaymentSync(ctx: Omit<AppContext, "actor">, configPath: string) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as Config;
  const endpoint = new URL(cfg.cloud_api_base);
  if (endpoint.protocol !== "https:" || !cfg.api_key?.trim()) {
    throw new Error("ERP sync requires an HTTPS cloud URL and API key");
  }
  const staff = ctx.db.prepare(
    "SELECT id, name, role FROM staff WHERE username = ? AND active = 1 AND role IN ('OWNER', 'MANAGER', 'CASHIER')",
  ).get(cfg.pos_staff_username ?? "cashier") as { id: string; name: string; role: Actor["role"] } | undefined;
  const terminal = ctx.db.prepare("SELECT id, name FROM terminals WHERE name = ? ORDER BY id LIMIT 1")
    .get(cfg.pos_terminal_name ?? "POS-01") as { id: string; name: string } | undefined;
  if (!staff || !terminal) throw new Error("ERP sync staff username or terminal name is missing from the POS");
  const paymentCtx: AppContext = {
    ...ctx,
    actor: { staffId: staff.id, staffName: staff.name, role: staff.role, terminalId: terminal.id, terminalName: terminal.name },
  };

  const interval = (cfg.poll_interval_seconds ?? 10) * 1000;
  const timeout = cfg.fetch_timeout_ms ?? 15_000;
  const batch = cfg.batch_size ?? 25;
  if (![interval, timeout, batch].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)) {
    throw new Error("Invalid ERP sync polling settings");
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      await syncErpPayments(paymentCtx, endpoint, cfg.api_key, batch, timeout);
    } catch (error) {
      console.error("ERP payment sync:", error instanceof Error ? error.message : "Polling failed");
    } finally {
      if (!stopped) timer = setTimeout(() => void run(), interval).unref();
    }
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export async function syncErpPayments(ctx: AppContext, endpoint: URL, key: string, batch: number, timeout: number) {
  async function request(route: string, body?: object, optional = false): Promise<Entry[]> {
    const url = new URL(endpoint);
    url.searchParams.set("route", route);
    url.searchParams.set("key", key);
    if (!body) url.searchParams.set("limit", String(batch));
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
    if (optional && response.status === 404) return [];
    if (!response.ok) throw new Error(`${route} failed (HTTP ${response.status})`);
    const data = await response.json() as { ok?: boolean; entries?: Entry[] };
    if (!data?.ok || (data.entries !== undefined && !Array.isArray(data.entries))) {
      throw new Error(`${route} returned an invalid response`);
    }
    return data.entries ?? [];
  }

  for (const updating of [false, true]) {
    const pending = updating ? "erp-sync-updates-pending" : "erp-sync-pending";
    const ack = updating ? "erp-sync-update-ack" : "erp-sync-ack";
    for (const entry of await request(pending, undefined, updating)) {
      const id = entry?.id;
      if ((typeof id !== "string" && typeof id !== "number") || !String(id).trim()) {
        console.error("ERP payment sync: Missing entry ID");
        continue;
      }

      let bookingNo: string | undefined;
      try {
        bookingNo = ctx.db.transaction(() => {
          if (updating) {
            updateBooking(ctx, entry);
            return undefined;
          }
          return createBooking(ctx, entry, String(id).trim());
        }).immediate();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Local payment sync failed";
        console.error("ERP payment sync rejected entry", id, message);
        await request(ack, { id, success: false, error: message }).catch(() => {
          console.error("ERP payment sync could not report failure for entry", id);
        });
        continue;
      }
      await request(ack, { id, success: true, ...(bookingNo ? { booking_no: bookingNo } : {}) }).catch(() => {
        console.error("ERP payment sync could not acknowledge committed entry", id);
      });
    }
  }
}
