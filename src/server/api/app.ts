import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import type Database from "better-sqlite3";
import type { Actor, BillDetails, BillLineEdit, ServiceChargeMode } from "../../shared/types.js";
import { billApprovalFields } from "../../shared/billApproval.js";
import { canViewNcEstimate, isAdminActor, isAdvanceOutlet, isBarOrderOnly, isUserRoleLabel, rightOn } from "../../shared/userRights.js";
import { hasPermission, type Permission } from "../../shared/permissions.js";
import { AppError } from "../lib/errors.js";
import { createBackgroundReports } from "./backgroundReports.js";
import type { AppContext } from "../lib/context.js";
import { createHardware, type HardwareBus } from "../hardware/index.js";
import { getKotPrintJob } from "../services/kotPrintQueue.js";
import * as cards from "../services/cardService.js";
import * as tables from "../services/tableService.js";
import * as orders from "../services/orderService.js";
import * as billing from "../services/billingService.js";
import * as reports from "../services/reportService.js";
import * as sync from "../services/syncService.js";
import * as staff from "../services/staffService.js";
import * as inventory from "../services/inventoryService.js";
import * as settings from "../services/settingsService.js";
import * as items from "../services/itemService.js";
import * as complimentary from "../services/complimentaryService.js";

declare global {
  namespace Express {
    interface Request {
      ctx: AppContext;
    }
  }
}

export interface CreateAppOptions {
  db: Database.Database;
  hardware?: HardwareBus;
  online?: boolean;
  queuePrinting?: boolean;
}

function billToUpdate(ctx: AppContext, orderId: string, invoiceId?: string) {
  const invoice = ctx.db.prepare(
    `SELECT id, status, bill_details, customer_display_name, customer_gstin, complimentary_account_id,
            discount, other_charges, service_charge_pct, service_charge_mode, service_charge
       FROM invoices WHERE order_id = ?
      AND status IN ('UNPAID', 'PARTIAL', 'PAID') AND (? IS NULL OR id = ?)
      ORDER BY created_at DESC LIMIT 1`,
  ).get(orderId, invoiceId ?? null, invoiceId ?? null) as {
    id: string;
    status: string;
    bill_details: string | null;
    customer_display_name: string;
    customer_gstin: string;
    complimentary_account_id: string | null;
    discount: number;
    other_charges: number;
    service_charge_pct: number;
    service_charge_mode: ServiceChargeMode;
    service_charge: number;
  } | undefined;
  if (invoiceId && !invoice) throw new AppError("Bill is no longer available to update", 409);
  return invoice;
}

function advanceBillAdjustments(
  ctx: AppContext,
  orderId: string,
  options: Request["body"],
  edits: BillLineEdit[],
) {
  const existing = billToUpdate(ctx, orderId, options.invoiceId);
  let details: Partial<BillDetails> = {};
  try { details = JSON.parse(existing?.bill_details || "{}") ?? {}; } catch { /* Legacy bill details. */ }
  if (["discount", "discountPct", "discountFrom", "excludeItemIds", "discountReviewedItemIds"]
      .some((key) => options[key] != null) ||
      options.billDetails?.discountPct != null || options.billDetails?.excludeItemIds != null) {
    throw new AppError("Advance users cannot change discounts", 403);
  }
  if (edits.length ||
      (options.otherCharges != null && options.otherCharges !== (existing?.other_charges ?? 0)) ||
      (options.complimentary != null && options.complimentary !== Boolean(existing?.complimentary_account_id)) ||
      (options.complimentaryAccountId != null && options.complimentaryAccountId !== existing?.complimentary_account_id)) {
    throw new AppError("Advance users can only remove service charge from a bill", 403);
  }
  const currentRate = existing && (existing.service_charge_pct || !existing.service_charge)
    ? existing.service_charge_pct : 10;
  if ((options.serviceChargePct != null && options.serviceChargePct !== currentRate && options.serviceChargePct !== 0) ||
      (options.serviceChargeMode != null && options.serviceChargeMode !== existing?.service_charge_mode)) {
    throw new AppError("Advance users can only remove service charge from a bill", 403);
  }
  return {
    invoiceId: existing?.id,
    discount: existing?.discount,
    excludeItemIds: existing ? details?.excludeItemIds ?? [] : undefined,
    otherCharges: existing?.other_charges,
    serviceChargePct: options.serviceChargePct ?? currentRate,
    serviceChargeMode: existing?.service_charge_mode,
  };
}

function applyBillEdits(ctx: AppContext, orderId: string, edits: BillLineEdit[], allowPaid: boolean) {
  for (const edit of edits) {
    switch (edit.kind) {
      case "add":
        if (!/^bill-[0-9a-f]{32}$/.test(edit.id)) throw new AppError("Invalid bill item ID");
        orders.addItem(ctx, { orderId, productId: edit.productId, qty: edit.qty, outlet: edit.outlet }, { id: edit.id, allowPaid });
        break;
      case "product":
        orders.setBillLineProduct(ctx, orderId, edit.ids, edit.productId, edit.outlet, { allowPaid });
        break;
      case "qty":
        orders.setBillLineQty(ctx, orderId, edit.ids, edit.qty, { allowPaid });
        break;
      case "price":
        orders.setBillLinePrice(ctx, orderId, edit.ids, edit.price, { allowPaid });
        break;
      default:
        throw new AppError("Invalid bill edit");
    }
  }
}

export function createApp(options: CreateAppOptions) {
  const app = express();
  const report = createBackgroundReports();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  const hardware = options.hardware ?? createHardware();
  const sessionCookie = "boss_pos_session";
  const sessionIdleMs = 24 * 60 * 60 * 1000;
  const sessions = new Map<string, { actor: Actor; expiresAt: number }>();
  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, path: "/api" };
  let online = options.online ?? true;

  function sessionId(req: Request) {
    return req.headers.cookie?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1) ?? "";
  }

  function sessionActor(req: Request, refresh = true) {
    const id = sessionId(req);
    const session = sessions.get(id);
    if (!session) return undefined;
    const now = Date.now();
    if (session.expiresAt <= now) {
      sessions.delete(id);
      return undefined;
    }
    if (refresh) session.expiresAt = now + sessionIdleMs;
    return session.actor;
  }

  const guestActor = (): Actor => {
    const first = options.db.prepare("SELECT * FROM staff WHERE username='cashier'").get() as
      | { id: string; name: string; role: Actor["role"] }
      | undefined;
    const terminal = options.db.prepare("SELECT * FROM terminals LIMIT 1").get() as { id: string; name: string };
    return {
      staffId: first?.id ?? "anonymous",
      staffName: first?.name ?? "Cashier",
      role: first?.role ?? "CASHIER",
      terminalId: terminal.id,
      terminalName: terminal.name,
    };
  };

  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    req.ctx = {
      db: options.db,
      actor: sessionActor(req, req.method !== "GET" || req.path !== "/api/session") ?? guestActor(),
      hardware,
      online,
      officeTerminal: req.socket.remoteAddress?.replace(/^::ffff:/i, "") === (process.env.POS_OFFICE_TERMINAL_IP?.trim() || "192.168.1.21"),
    };
    next();
  });

  const wrap =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(next);
    };

  const requirePerm = (permission: Permission) => (req: Request, _res: Response, next: NextFunction) => {
    if (!hasPermission(req.ctx.actor.role, permission)) {
      next(new AppError(`Permission denied: ${permission}`, 403, "PERMISSION_DENIED"));
      return;
    }
    next();
  };

  function assertBarTable(ctx: AppContext, tableId: string) {
    const table = ctx.db.prepare(
      "SELECT status FROM dining_tables WHERE id = ? AND COALESCE(NULLIF(outlet, ''), 'BAR') = 'BAR'",
    ).get(tableId) as { status: string } | undefined;
    if (!table) throw new AppError("Only Bar tables are available", 403);
    if (table.status === "PAYMENT_PENDING") throw new AppError("Bill already printed", 409);
  }

  function assertBarOrder(ctx: AppContext, orderId: string) {
    const order = ctx.db.prepare(
      "SELECT o.table_id FROM orders o JOIN dining_tables t ON t.id = o.table_id AND t.current_session_id = o.session_id WHERE o.id = ? AND o.status IN ('OPEN', 'BILL_REQUESTED')",
    ).get(orderId) as { table_id: string } | undefined;
    if (!order) throw new AppError("Order no longer accepts items", 409);
    assertBarTable(ctx, order.table_id);
  }

  function assertAdvanceAccess(req: Request) {
    const route = req.path.replace(/\/$/, "");
    const denied = () => new AppError("Permission denied for Advance users", 403, "PERMISSION_DENIED");
    const body = req.body ?? {};
    const outletFor = (sql: string, id: unknown, ...additionalParams: string[]) => {
      if (typeof id !== "string") throw denied();
      const row = req.ctx.db.prepare(sql).get(id, ...additionalParams) as { outlet?: string } | undefined;
      if (!row || !isAdvanceOutlet(row.outlet || "BAR")) throw denied();
    };
    const checkTable = (id: unknown) => outletFor("SELECT outlet FROM dining_tables WHERE id = ?", id);
    const checkOrder = (id: unknown) => outletFor(
      "SELECT t.outlet FROM orders o JOIN dining_tables t ON t.id = o.table_id WHERE o.id = ?", id,
    );
    const checkInvoice = (id: unknown) => outletFor(
      "SELECT t.outlet FROM invoices i JOIN dining_tables t ON t.id = i.table_id WHERE i.id = ?", id,
    );
    const checkPayment = (id: unknown) => outletFor(
      "SELECT t.outlet FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN dining_tables t ON t.id = i.table_id WHERE p.id = ?", id,
    );
    const checkKot = (id: string) => outletFor(
      "SELECT t.outlet FROM kots k JOIN dining_tables t ON t.id = k.table_id WHERE k.id = ? OR k.kot_number = ?", id, id,
    );
    if ((body.outlet != null && !isAdvanceOutlet(body.outlet)) ||
        (body.billDetails?.outlet != null && !isAdvanceOutlet(body.billDetails.outlet)) ||
        (Array.isArray(body.edits) && body.edits.some((edit: BillLineEdit & { outlet?: string }) =>
          edit?.outlet != null && !isAdvanceOutlet(edit.outlet)))) throw denied();

    if (req.method === "GET") {
      if (["/api/bootstrap", "/api/tables", "/api/session", "/api/products", "/api/invoices",
        "/api/complimentary", "/api/cards/balance/check", "/api/cards/recharged-today",
        "/api/reports/settlement/users"].includes(route)) return;
      if (["/api/reports/kots", "/api/reports/bills", "/api/reports/settlement"].includes(route)) {
        if (!isAdvanceOutlet(req.query.outlet)) throw denied();
        return;
      }
      const resource = /^\/api\/(orders|invoices|tables|reports\/kots|reports\/settlement)\/([^/]+)(\/(?:items|invoice))?$/.exec(route);
      if (!resource) throw denied();
      const id = decodeURIComponent(resource[2]);
      if (resource[1] === "orders") checkOrder(id);
      if (resource[1] === "invoices") checkInvoice(id);
      if (resource[1] === "tables") checkTable(id);
      if (resource[1] === "reports/kots") checkKot(id);
      if (resource[1] === "reports/settlement") checkPayment(id);
      return;
    }

    if (req.method === "PUT") {
      const payment = /^\/api\/reports\/settlement\/([^/]+)$/.exec(route);
      if (!payment) throw denied();
      checkPayment(decodeURIComponent(payment[1]));
      return;
    }

    if (req.method !== "POST") throw denied();
    if (["/api/auth/login", "/api/auth/logout", "/api/auth/change-password", "/api/tables"].includes(route)) return;
    if (route === "/api/tables/transfer" || route === "/api/tables/item-transfer") {
      checkTable(body.fromTableId);
      checkTable(body.toTableId);
      return;
    }
    if (route === "/api/orders") {
      checkTable(body.tableId);
      return;
    }
    if (route === "/api/invoices/preview" || route === "/api/invoices/generate") {
      checkOrder(body.orderId);
      if (body.invoiceId) checkInvoice(body.invoiceId);
      return;
    }
    const resource = /^\/api\/(orders|invoices|tables|order-items|kots)\/([^/]+)\/([^/]+)$/.exec(route);
    if (!resource) throw denied();
    const [, kind, encodedId, action] = resource;
    const id = decodeURIComponent(encodedId);
    if (kind === "tables" && ["open", "card", "request-bill"].includes(action)) {
      checkTable(id);
      return;
    }
    if (kind === "orders" && ["items", "send-kot", "estimate"].includes(action)) {
      checkOrder(id);
      return;
    }
    if (kind === "invoices" && ["pay", "settle-club", "print"].includes(action)) {
      checkInvoice(id);
      return;
    }
    if (kind === "order-items" && action === "cancel") {
      outletFor("SELECT t.outlet FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN dining_tables t ON t.id = o.table_id WHERE oi.id = ? AND oi.kot_id IS NULL", id);
      return;
    }
    if (kind === "kots" && action === "reprint") {
      checkKot(id);
      return;
    }
    throw denied();
  }

  const reportRouteRights: Record<string, string[]> = {
    gst: ["report.gst"],
    dashboard: ["report.pos"],
    reconciliation: ["report.pos"],
    sales: ["report.pos"],
    "item-wise": ["report.pos", "report.item", "report.itemDetail", "report.stock", "report.outlet", "report.time", "report.tax"],
    kots: ["report.kot"],
    bills: ["report.bill"],
    settlement: ["report.settlement"],
    "card-settlement": ["report.card", "report.booking"],
    "item-transfers": ["report.itemTransfer"],
    "table-transfers": ["report.tableTransfer"],
    "kot-cancellations": ["report.kotCancellation"],
  };

  app.use((req, _res, next) => {
    if (req.method === "POST" && /^\/api\/(?:tables|orders|order-items|invoices)(?:\/|$)/i.test(req.path) &&
        (req.ctx.actor.staffId === "anonymous" ||
          ((req.get("X-POS-Client") === "1" || sessionId(req)) && !sessionActor(req, false)))) {
      throw new AppError("Session expired.", 401, "SESSION_REQUIRED");
    }
    const reportRoute = /^\/api\/reports\/([^/]+)/i.exec(req.path)?.[1].toLowerCase();
    const reportRights = reportRoute && Object.hasOwn(reportRouteRights, reportRoute) ? reportRouteRights[reportRoute] : undefined;
    if (reportRights && !reportRights.some((right) => rightOn(req.ctx.actor.rights, right))) {
      throw new AppError("Report permission denied", 403, "PERMISSION_DENIED");
    }
    if (req.ctx.actor.userGroup === "CASHIER") {
      const route = req.path.replace(/\/+$/, "").toLowerCase();
      const master = /^\/api\/(?:staff|items|item-groups)(?:\/|$)/.test(route) ||
        (req.method !== "GET" && /^\/api\/(?:complimentary|bonus-rules)(?:\/|$)/.test(route));
      if (master) throw new AppError("Cashier users cannot access Master", 403, "PERMISSION_DENIED");
    }
    // Only the originating terminal receives the randomly generated print job ID.
    if (req.method === "POST" && /^\/api\/kot-print-jobs\/[0-9a-f-]{36}\/?$/i.test(req.path)) return next();
    if (req.ctx.actor.userGroup === "ADVANCE" && /^\/api(?:\/|$)/i.test(req.path)) {
      assertAdvanceAccess(req);
      return next();
    }
    if (!isBarOrderOnly(req.ctx.actor.rights) || !/^\/api(?:\/|$)/i.test(req.path)) return next();

    const route = req.path.replace(/\/$/, "");
    if (req.ctx.actor.userGroup === "OPERATOR" && req.method === "GET") {
      if (/^\/api\/reports\/(?:kots|bills|settlement)$/.test(route) && req.query.outlet === "BAR") {
        return next();
      }
      const kotDetail = /^\/api\/reports\/kots\/([^/]+)$/.exec(route);
      if (kotDetail && req.ctx.db.prepare(
        "SELECT 1 FROM kots k JOIN dining_tables t ON t.id = k.table_id WHERE k.id = ? AND COALESCE(NULLIF(t.outlet, ''), 'BAR') = 'BAR'",
      ).get(decodeURIComponent(kotDetail[1]))) return next();
    }
    const allowedRead = req.method === "GET" && (
      ["/api/bootstrap", "/api/tables", "/api/session"].includes(route) ||
      /^\/api\/orders\/[^/]+$/.test(route) || /^\/api\/tables\/[^/]+\/items$/.test(route)
    );
    const allowedWrite = req.method === "POST" && (
      ["/api/auth/logout", "/api/auth/login", "/api/auth/change-password", "/api/orders", "/api/tables"].includes(route)
      || /^\/api\/tables\/[^/]+\/open$/.test(route)
      || /^\/api\/orders\/[^/]+\/(items|send-kot|estimate)$/.test(route)
      || /^\/api\/order-items\/[^/]+\/cancel$/.test(route)
    );
    if (allowedRead || allowedWrite) return next();
    next(new AppError("Permission denied: Bar orders only", 403, "PERMISSION_DENIED"));
  });

  app.post(
    "/api/auth/login",
    wrap((req, res) => {
      const actor = staff.login(
        req.ctx,
        req.body.username,
        req.body.password ?? req.body.pin,
        req.body.terminalId ?? req.ctx.actor.terminalId,
      );
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(id);
      }
      sessions.delete(sessionId(req));
      const id = randomUUID();
      sessions.set(id, { actor, expiresAt: now + sessionIdleMs });
      res.cookie(sessionCookie, id, { ...cookieOptions, secure: req.secure });
      res.json(actor);
    }),
  );

  app.post("/api/auth/logout", (req, res) => {
    sessions.delete(sessionId(req));
    res.clearCookie(sessionCookie, { ...cookieOptions, secure: req.secure });
    res.json({ ok: true });
  });

  app.post(
    "/api/auth/change-password",
    wrap((req, res) => {
      res.json(staff.changePassword(
        req.ctx,
        req.body.username,
        req.body.oldPassword ?? req.body.pin,
        req.body.newPassword ?? req.body.newPin,
      ));
    }),
  );

  app.get("/api/session", (req, res) => {
    res.json({
      authenticated: Boolean(sessionActor(req, false)),
      actor: req.ctx.actor,
      online: req.ctx.online,
      sync: sync.syncStatus(req.ctx),
    });
  });

  app.post("/api/session/online", (req, res) => {
    online = Boolean(req.body.online);
    res.json({ online });
  });

  app.get("/api/bootstrap", wrap((req, res) => {
    const barOnly = isBarOrderOnly(req.ctx.actor.rights);
    res.json({
      actor: req.ctx.actor,
      floors: barOnly ? [] : tables.listFloors(req.ctx),
      tables: tables.listTables(req.ctx),
      products: staff.listProducts(req.ctx),
      cardTypes: barOnly ? [] : staff.listCardTypes(req.ctx),
      staff: barOnly ? [] : staff.listStaff(req.ctx),
      settings: barOnly ? {} : settings.getAllSettings(req.ctx),
      sync: sync.syncStatus(req.ctx),
    });
  }));

  app.get("/api/customers", wrap((req, res) => {
    res.json(staff.listCustomers(req.ctx, String(req.query.q ?? "")));
  }));
  app.post("/api/customers", wrap((req, res) => {
    res.json(cards.createOrFindCustomer(req.ctx, req.body));
  }));

  app.get("/api/complimentary", wrap((req, res) => {
    res.json(complimentary.listComplimentary(req.ctx));
  }));
  app.post("/api/complimentary", wrap((req, res) => {
    res.json(complimentary.createComplimentary(req.ctx, String(req.body?.name ?? "")));
  }));
  app.put("/api/complimentary/:id", wrap((req, res) => {
    res.json(complimentary.updateComplimentary(req.ctx, req.params.id, String(req.body?.name ?? "")));
  }));
  app.delete("/api/complimentary/:id", wrap((req, res) => {
    res.json(complimentary.deleteComplimentary(req.ctx, req.params.id));
  }));

  app.get("/api/cards/balance/check", wrap((req, res) => {
    const result = cards.checkBalance(req.ctx, String(req.query.q ?? ""), req.query.exact === "1");
    const except = String(req.query.exceptOrderId ?? "").trim() || undefined;
    const spend = billing.cardSpendable(req.ctx, result.card.id, except);
    res.json({
      ...result,
      balances: { ...result.balances, reserved: spend.reserved, available: spend.available },
    });
  }));
  app.get("/api/cards/recharged-today", wrap((req, res) => {
    const except = String(req.query.exceptOrderId ?? "").trim() || undefined;
    const rows = cards.cardsRechargedToday(req.ctx);
    res.json(rows.map((row) => {
      const spend = billing.cardSpendable(req.ctx, row.id, except);
      return { ...row, reserved: spend.reserved, available: spend.available };
    }));
  }));
  app.get("/api/cards", wrap((req, res) => {
    if (req.query.q) {
      const query = String(req.query.q).trim();
      if (req.query.exact === "1") {
        const card = cards.findCardByScan(req.ctx, query);
        res.json(card ? [card] : []);
      } else {
        res.json(cards.searchCards(req.ctx, query));
      }
      return;
    }
    res.json(cards.listCards(req.ctx, req.query.status ? String(req.query.status) : undefined));
  }));
  app.get("/api/cards/blocked", requirePerm("CARD_BLOCK"), wrap((req, res) => res.json(cards.listBlockedCards(req.ctx))));
  app.get("/api/cards/:id", wrap((req, res) => res.json(cards.getCard(req.ctx, req.params.id))));
  app.get("/api/cards/:id/ledger", wrap((req, res) => {
    res.json(
      cards.cardLedger(req.ctx, {
        cardId: req.params.id,
        type: req.query.type as never,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      }),
    );
  }));
  app.get("/api/ledger", wrap((req, res) => {
    res.json(
      cards.cardLedger(req.ctx, {
        cardId: req.query.cardId ? String(req.query.cardId) : undefined,
        customerId: req.query.customerId ? String(req.query.customerId) : undefined,
        type: req.query.type as never,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      }),
    );
  }));
  app.post("/api/cards/issue", requirePerm("ISSUE_CARD"), wrap((req, res) => {
    res.json(cards.issueCard(req.ctx, req.body));
  }));
  app.post("/api/cards/:id/recharge", requirePerm("RECHARGE"), wrap((req, res) => {
    res.json(cards.rechargeCard(req.ctx, { cardId: req.params.id, ...req.body }));
  }));
  app.post("/api/cards/swap", requirePerm("CARD_SWAP"), wrap((req, res) => {
    res.json(cards.swapCard(req.ctx, req.body));
  }));
  app.post("/api/cards/:id/block", requirePerm("CARD_BLOCK"), wrap((req, res) => {
    res.json(cards.blockCard(req.ctx, req.params.id, req.body.reason));
  }));
  app.post("/api/cards/:id/unblock", requirePerm("CARD_UNBLOCK"), wrap((req, res) => {
    res.json(cards.unblockCard(req.ctx, req.params.id, req.body.reason));
  }));

  app.get("/api/floors", wrap((req, res) => res.json(tables.listFloors(req.ctx))));
  app.get("/api/tables", wrap((req, res) => res.json(tables.listTables(req.ctx))));
  app.post("/api/tables", wrap((req, res) => {
    const body = req.body ?? {};
    if (!isBarOrderOnly(req.ctx.actor.rights)) return res.json(tables.createTable(req.ctx, body));
    if (body.outlet != null && body.outlet !== "BAR") throw new AppError("Permission denied: Bar orders only", 403);
    return res.json(tables.createTable(req.ctx, { code: body.code, outlet: "BAR" }));
  }));
  app.get("/api/tables/waiter", wrap((req, res) => res.json(tables.waiterTables(req.ctx, req.ctx.actor.staffId))));
  app.post("/api/tables/:id/open", wrap((req, res) => {
    if (isBarOrderOnly(req.ctx.actor.rights)) {
      assertBarTable(req.ctx, req.params.id);
      return res.json(tables.openTable(req.ctx, { tableId: req.params.id }));
    }
    res.json(tables.openTable(req.ctx, { ...req.body, tableId: req.params.id }));
  }));
  app.post("/api/tables/:id/card", wrap((req, res) => {
    res.json(tables.attachTableCard(req.ctx, req.params.id, String(req.body?.cardNumber ?? "")));
  }));
  app.post("/api/tables/:id/checkin", wrap((req, res) => {
    res.json(tables.checkIn(req.ctx, { tableId: req.params.id, ...req.body }));
  }));
  app.post("/api/tables/:id/request-bill", wrap((req, res) => res.json(tables.requestBill(req.ctx, req.params.id))));
  app.post("/api/tables/transfer", wrap((req, res) => {
    res.json(tables.transferTableAndPrint(req.ctx, req.body.fromTableId, req.body.toTableId, req.body.reason));
  }));
  app.get("/api/tables/:id/items", wrap((req, res) => res.json(tables.listTableItems(req.ctx, req.params.id))));
  app.post("/api/tables/item-transfer", wrap((req, res) => {
    res.json(tables.transferItems(
      req.ctx,
      req.body.fromTableId,
      req.body.toTableId,
      req.body.itemIds ?? [],
      req.body.reason,
    ));
  }));
  app.post("/api/tables/merge", wrap((req, res) => {
    res.json(tables.mergeTables(req.ctx, req.body.sourceTableId, req.body.targetTableId));
  }));
  app.post("/api/tables/split", wrap((req, res) => res.json(tables.splitTable(req.ctx, req.body))));

  app.get("/api/products", wrap((req, res) => res.json(staff.listProducts(req.ctx))));
  app.get("/api/items/master", wrap((req, res) => res.json(items.listItemMaster(req.ctx))));
  app.post("/api/items", wrap((req, res) => res.json(items.createItem(req.ctx, req.body ?? {}))));
  app.put("/api/items/:id", wrap((req, res) => res.json(items.updateItem(req.ctx, req.params.id, req.body ?? {}))));
  app.delete("/api/items/:id", wrap((req, res) => res.json(items.deleteItem(req.ctx, req.params.id))));
  app.post("/api/item-groups", wrap((req, res) => res.json(items.addItemGroup(req.ctx, req.body?.name ?? ""))));
  app.get("/api/orders", wrap((req, res) => res.json(orders.listOrders(req.ctx))));
  app.get("/api/orders/:id", wrap((req, res) => {
    if (isBarOrderOnly(req.ctx.actor.rights)) assertBarOrder(req.ctx, req.params.id);
    res.json(orders.getOrderDetail(req.ctx, req.params.id));
  }));
  app.post("/api/orders", wrap((req, res) => {
    if (isBarOrderOnly(req.ctx.actor.rights)) assertBarTable(req.ctx, req.body.tableId);
    res.json(orders.createOrder(req.ctx, req.body.tableId));
  }));
  app.post("/api/orders/:id/estimate", wrap((req, res) => {
    const orderId = req.params.id;
    const { items } = req.body;
    if (!canViewNcEstimate(req.ctx.actor) && billing.orderOutlet(req.ctx, orderId) === "NC") {
      throw new AppError("Estimate permission denied", 403, "PERMISSION_DENIED");
    }
    const barOnly = isBarOrderOnly(req.ctx.actor.rights);
    if (barOnly) assertBarOrder(req.ctx, orderId);
    const outlet = barOnly ? "BAR" : req.body.outlet;
    if (!Array.isArray(items)) throw new AppError("Items are required");
    const rollback = new Error("Estimate complete");
    let grandTotal = 0;
    try {
      req.ctx.db.transaction(() => {
        for (const { productId, qty, notes } of items) {
          if (barOnly && (!Number.isInteger(qty) || qty < 1)) throw new AppError("Enter a positive quantity");
          orders.addItem(req.ctx, { orderId, productId, qty, notes, outlet });
        }
        grandTotal = billing.previewRunningBill(req.ctx, orderId).grandTotal;
        throw rollback;
      })();
    } catch (err) {
      if (err !== rollback) throw err;
    }
    res.json({ grandTotal });
  }));
  app.post("/api/orders/:id/items", wrap((req, res) => {
    if (isBarOrderOnly(req.ctx.actor.rights)) {
      assertBarOrder(req.ctx, req.params.id);
      const { productId, qty, notes } = req.body;
      if (!Number.isInteger(qty) || qty < 1) throw new AppError("Enter a positive quantity");
      return res.json(orders.addItem(req.ctx, { orderId: req.params.id, productId, qty, notes, outlet: "BAR" }));
    }
    res.json(orders.addItem(req.ctx, { ...req.body, orderId: req.params.id }));
  }));
  app.post("/api/orders/:id/bill-qty", wrap((req, res) => {
    res.json(orders.setBillLineQty(req.ctx, req.params.id, req.body.ids ?? [], Number(req.body.qty)));
  }));
  app.post("/api/orders/:id/bill-item", wrap((req, res) => {
    res.json(orders.setBillLineProduct(req.ctx, req.params.id, req.body.ids ?? [], req.body.productId, req.body.outlet));
  }));
  app.post("/api/orders/:id/bill-price", wrap((req, res) => {
    res.json(orders.setBillLinePrice(req.ctx, req.params.id, req.body.ids ?? [], Math.round(Number(req.body.price))));
  }));
  app.post("/api/orders/:id/send-kot", wrap(async (req, res) => {
    const barOnly = isBarOrderOnly(req.ctx.actor.rights);
    if (barOnly) assertBarOrder(req.ctx, req.params.id);
    const remark = typeof req.body?.remark === "string" ? req.body.remark : undefined;
    const steward = typeof req.body?.steward === "string" ? req.body.steward : undefined;
    const cardNumber = !barOnly && typeof req.body?.cardNumber === "string" ? req.body.cardNumber : undefined;
    res.json(await orders.sendKot(req.ctx, req.params.id, {
      remark, steward, cardNumber, queuePrinting: options.queuePrinting !== false,
    }));
  }));
  app.post("/api/kot-print-jobs/:id", wrap((req, res) => {
    if (options.queuePrinting === false) throw new AppError("Print job not found", 404);
    res.json(getKotPrintJob(req.ctx.db, req.params.id, req.body?.action, req.body?.error, req.ctx.officeTerminal));
  }));
  app.post("/api/order-items/:id/qty", wrap((req, res) => {
    res.json(orders.modifyItemQty(req.ctx, req.params.id, Number(req.body.qty)));
  }));
  app.post("/api/order-items/:id/notes", wrap((req, res) => {
    res.json(orders.setItemNotes(req.ctx, req.params.id, String(req.body?.notes ?? "")));
  }));
  app.post("/api/order-items/:id/cancel", wrap((req, res) => {
    if (isBarOrderOnly(req.ctx.actor.rights)) {
      const draft = req.ctx.db.prepare(
        "SELECT order_id FROM order_items WHERE id = ? AND kot_id IS NULL AND qty > 0 AND voided = 0",
      ).get(req.params.id) as { order_id: string } | undefined;
      if (!draft) throw new AppError("Only unsent items can be discarded", 403);
      assertBarOrder(req.ctx, draft.order_id);
    }
    res.json(orders.cancelItem(req.ctx, req.params.id, req.body.reason ?? "cancelled"));
  }));

  app.get("/api/kots", wrap((req, res) => {
    res.json(orders.listKots(req.ctx, req.query.station as never));
  }));
  app.post("/api/kots/:id/status", wrap((req, res) => {
    res.json(orders.advanceKot(req.ctx, req.params.id, req.body.status));
  }));
  app.post("/api/kots/:id/reprint", wrap(async (req, res) => {
    res.json(await orders.reprintKot(req.ctx, req.params.id));
  }));
  app.post("/api/kots/:id/void", wrap((req, res) => {
    res.json(orders.voidKot(req.ctx, req.params.id, req.body.reason ?? "void"));
  }));

  app.post("/api/invoices/preview", wrap((req, res) => {
    const { orderId, invoiceId, edits = [] } = req.body;
    if (req.ctx.actor.userGroup === "ADVANCE") {
      res.json(billing.previewBill(req.ctx, orderId, advanceBillAdjustments(req.ctx, orderId, req.body, edits)));
      return;
    }
    if (!edits.length) {
      res.json(billing.previewBill(req.ctx, orderId, req.body));
      return;
    }
    // Use the same order and inventory rules for previews, then roll back.
    const rollback = new Error();
    let preview: ReturnType<typeof billing.previewBill> | undefined;
    try {
      req.ctx.db.transaction(() => {
        const existing = billToUpdate(req.ctx, orderId, invoiceId);
        applyBillEdits(req.ctx, orderId, edits, existing?.status === "PAID");
        preview = billing.previewBill(req.ctx, orderId, req.body);
        throw rollback;
      })();
    } catch (err) {
      if (err !== rollback) throw err;
    }
    res.json(preview);
  }));
  app.post("/api/invoices/generate", wrap((req, res) => {
    const { orderId, invoiceId, edits = [], masterPin, ...billOptions } = req.body;
    const admin = isAdminActor(sessionActor(req));
    if (!admin && masterPin && !settings.verifyMasterPin(req.ctx, masterPin)) {
      throw new AppError("Incorrect master PIN", 403);
    }
    const invoice = req.ctx.db.transaction(() => {
      const advance = req.ctx.actor.userGroup === "ADVANCE";
      const adjustments = advance ? advanceBillAdjustments(req.ctx, orderId, { ...billOptions, invoiceId }, edits) : undefined;
      const existing = billToUpdate(req.ctx, orderId, invoiceId);
      let savedDetails: Partial<BillDetails> = {};
      try { savedDetails = JSON.parse(existing?.bill_details || "{}") ?? {}; } catch { /* Legacy bill details. */ }
      const customer = existing ? undefined : req.ctx.db.prepare(
        `SELECT cu.name, cu.mobile FROM orders o
         LEFT JOIN member_cards c ON c.id = o.card_id
         LEFT JOIN customers cu ON cu.id = COALESCE(o.customer_id, c.customer_id)
         WHERE o.id = ?`,
      ).get(orderId) as { name: string | null; mobile: string | null } | undefined;
      const savedFields = {
        billDetails: existing ? savedDetails : {
          mobile: billOptions.billDetails?.mobile?.trim() === customer?.mobile ? customer?.mobile ?? "" : "",
        },
        customerDisplayName: existing?.customer_display_name ??
          (billOptions.customerDisplayName?.trim() === customer?.name ? customer?.name ?? "" : ""),
        customerGstin: existing?.customer_gstin,
        complimentaryAccountId: existing?.complimentary_account_id,
        otherCharges: existing?.other_charges,
        discount: existing?.discount,
        excludeItemIds: existing ? undefined : billing.previewBill(req.ctx, orderId, {
          discountCheckboxes: !advance && billOptions.discountCheckboxes === true,
        }, true).excludeItemIds,
      };
      const discountChanged = billOptions.discount != null || billOptions.discountPct != null || billOptions.discountFrom != null;
      const discountPct = discountChanged
        ? (billOptions.discountFrom === "amount" ? undefined : billOptions.discountPct)
        : savedDetails.discountPct;
      const submittedRemark = billOptions.billDetails?.remark;
      const remarkValue = billOptions.reason ?? (submittedRemark === savedDetails.remark ? undefined : submittedRemark);
      const remark = typeof remarkValue === "string" ? remarkValue.trim() : "";
      const savedServiceChargePct = existing && (existing.service_charge_pct || !existing.service_charge)
        ? existing.service_charge_pct : 10;
      const finalOptions = {
        ...billOptions,
        billDetails: {
          ...savedDetails,
          ...billOptions.billDetails,
          remark: remark || savedDetails.remark,
          discountPct,
        },
        complimentary: billOptions.complimentary ?? Boolean(existing?.complimentary_account_id),
        complimentaryAccountId: billOptions.complimentaryAccountId ?? existing?.complimentary_account_id,
        discount: discountChanged
          ? (discountPct != null || billOptions.discountFrom === "percent" ? undefined : billOptions.discount)
          : existing?.discount,
        discountPct,
        excludeItemIds: billOptions.excludeItemIds ?? billOptions.billDetails?.excludeItemIds ??
          savedDetails.excludeItemIds ?? (existing ? [] : undefined),
        otherCharges: billOptions.otherCharges ?? existing?.other_charges,
        serviceChargeMode: adjustments?.serviceChargeMode ?? billOptions.serviceChargeMode ?? existing?.service_charge_mode,
        serviceChargePct: adjustments?.serviceChargePct ?? billOptions.serviceChargePct ?? savedServiceChargePct,
      };
      if (!finalOptions.complimentary) finalOptions.complimentaryAccountId = undefined;
      finalOptions.billDetails.excludeItemIds = finalOptions.excludeItemIds;
      const needsApproval = edits.length || billApprovalFields({
        ...savedFields,
        ...finalOptions,
        billDetails: {
          ...finalOptions.billDetails,
          remark: finalOptions.serviceChargePct !== savedServiceChargePct
            ? savedDetails.remark : finalOptions.billDetails.remark,
        },
        excludeItemIds: finalOptions.excludeItemIds ?? savedFields.excludeItemIds,
      }) !== billApprovalFields(savedFields);
      if (needsApproval) {
        if (!remark && billing.orderOutlet(req.ctx, orderId) !== "NC") {
          throw new AppError("Enter a remark to update this bill", 403, "BILL_REMARK_REQUIRED", "billRemark");
        }
        if (!admin && !masterPin) {
          throw new AppError("Enter the master PIN to update this bill", 403);
        }
      }
      applyBillEdits(req.ctx, orderId, edits, existing?.status === "PAID");
      return billing.generateInvoice(req.ctx, orderId, {
        ...finalOptions,
        ...(advance ? { discount: adjustments?.discount, discountPct: undefined } : {}),
        invoiceId: existing?.id,
      });
    }).immediate();
    res.json(invoice);
  }));
  app.get("/api/invoices", wrap((req, res) => res.json(billing.listInvoices(req.ctx))));
  app.get("/api/tables/:id/invoice", wrap((req, res) => {
    res.json(billing.getOpenInvoiceByTable(req.ctx, req.params.id));
  }));
  app.get("/api/invoices/:id", wrap((req, res) => res.json(billing.getInvoice(req.ctx, req.params.id))));
  app.post("/api/invoices/:id/pay", wrap((req, res) => {
    res.json(billing.settleInvoice(req.ctx, req.params.id, req.body.lines, req.body));
  }));
  app.post("/api/invoices/:id/settle-club", wrap((req, res) => {
    res.json(billing.settleClubFromCard(req.ctx, req.params.id));
  }));
  app.post("/api/invoices/:id/print", wrap(async (req, res) => {
    res.json(await billing.printReceipt(req.ctx, req.params.id));
  }));
  app.post("/api/invoices/:id/refund", wrap((req, res) => {
    res.json(billing.refundInvoice(req.ctx, { invoiceId: req.params.id, ...req.body }));
  }));
  app.post("/api/invoices/:id/cancel", wrap((req, res) => {
    res.json(billing.cancelInvoice(req.ctx, req.params.id, req.body.reason));
  }));

  app.get("/api/inventory", wrap((req, res) => res.json(inventory.listInventory(req.ctx))));
  app.post("/api/purchases", wrap((req, res) => res.json(inventory.receivePurchase(req.ctx, req.body.supplier, req.body.items))));
  app.post("/api/expenses", wrap((req, res) => res.json(inventory.addExpense(req.ctx, req.body.category, req.body.amount, req.body.note))));

  app.get("/api/staff", wrap((req, res) => res.json(staff.listStaff(req.ctx))));
  app.post("/api/staff", wrap((req, res) => res.json(staff.createStaff(req.ctx, req.body))));
  app.put("/api/staff/:id", wrap((req, res) => res.json(staff.updateStaff(req.ctx, req.params.id, req.body))));
  app.delete("/api/staff/:id", wrap((req, res) => res.json(staff.deleteStaff(req.ctx, req.params.id))));

  app.put("/api/settings/master-pin", wrap((req, res) => {
    if (!isAdminActor(sessionActor(req))) throw new AppError("Only Admin users can change the master PIN", 403);
    settings.changeMasterPin(req.ctx, req.body?.currentPin, req.body?.newPin);
    res.json({ ok: true });
  }));
  app.get("/api/settings/group-reports/:group", wrap((req, res) => {
    if (!isAdminActor(sessionActor(req))) throw new AppError("Only Admin users can edit group report permissions", 403);
    if (!isUserRoleLabel(req.params.group)) throw new AppError("Select a user group");
    res.json(settings.getGroupReports(req.ctx, req.params.group));
  }));
  app.put("/api/settings/group-reports/:group", wrap((req, res) => {
    if (!isAdminActor(sessionActor(req))) throw new AppError("Only Admin users can edit group report permissions", 403);
    if (!isUserRoleLabel(req.params.group)) throw new AppError("Select a user group");
    res.json(settings.updateGroupReports(req.ctx, req.params.group, req.body));
  }));
  app.get("/api/settings", wrap((req, res) => res.json(settings.getAllSettings(req.ctx))));
  app.put("/api/settings", requirePerm("SETTINGS"), wrap((req, res) => {
    const changes = Object.entries(req.body ?? {});
    if (changes.some(([key]) => settings.isProtectedSetting(key))) {
      throw new AppError("Use User Master to update protected settings", 403);
    }
    for (const [key, value] of changes) {
      settings.setSetting(req.ctx, key, String(value));
    }
    res.json(settings.getAllSettings(req.ctx));
  }));
  app.get("/api/bonus-rules", wrap((req, res) => res.json(staff.listBonusRules(req.ctx))));
  app.post("/api/bonus-rules", wrap((req, res) => res.json(staff.upsertBonusRule(req.ctx, req.body))));

  app.get("/api/reports/dashboard", wrap((req, res) => {
    return report(req, res, "ownerDashboard", req.query.date ? String(req.query.date) : undefined);
  }));
  app.get("/api/reports/reconciliation", wrap((req, res) => {
    return report(req, res, "reconcile", req.query.date ? String(req.query.date) : undefined);
  }));
  app.get("/api/reports/sales", wrap((req, res) => {
    return report(req, res, "salesReport", req.query.date ? String(req.query.date) : undefined);
  }));
  app.get("/api/reports/item-wise", wrap((req, res) => {
    return report(req, res, "itemWiseSales", req.query.from ? String(req.query.from) : undefined, req.query.to ? String(req.query.to) : undefined);
  }));
  app.get("/api/reports/item-transfers", wrap((req, res) => {
    return report(req, res, "itemTransferReport", req.query.from ? String(req.query.from) : undefined, req.query.to ? String(req.query.to) : undefined);
  }));
  app.get("/api/reports/table-transfers", wrap((req, res) => {
    return report(req, res, "tableTransferReport", req.query.from ? String(req.query.from) : undefined, req.query.to ? String(req.query.to) : undefined);
  }));
  app.get("/api/reports/gst", wrap((req, res) => {
    const mode = String(req.query.mode || "bills").toLowerCase();
    const filters = {
      outlet: req.query.outlet ? String(req.query.outlet) : undefined,
      billNo: req.query.bill ? String(req.query.bill) : undefined,
      taxReport: req.query.tax ? String(req.query.tax) : undefined,
    };
    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;
    if (mode === "summary" || mode === "tax-summary") {
      return report(req, res, "gstTaxSummary", from, to, filters);
    }
    return report(req, res, "gstBillWise", from, to, filters);
  }));
  app.get("/api/reports/settlement", wrap((req, res) => {
    return report(req, res, "settlementReport",
      req.query.from ? String(req.query.from) : undefined,
      req.query.to ? String(req.query.to) : undefined,
      req.query.outlet ? String(req.query.outlet) : undefined,
      {
        mop: req.query.mop ? String(req.query.mop) : undefined,
        billNo: req.query.bill ? String(req.query.bill) : undefined,
        account: req.query.account ? String(req.query.account) : undefined,
        user: req.query.user ? String(req.query.user) : undefined,
        settledOnly: req.query.settled === "1",
      },
    );
  }));
  app.get("/api/reports/settlement/users", wrap((req, res) => {
    res.json(reports.settlementUsers(req.ctx));
  }));
  app.get("/api/reports/settlement/:paymentId", wrap((req, res) => {
    return report(req, res, "settlementDetail", req.params.paymentId);
  }));
  app.put("/api/reports/settlement/:paymentId", wrap((req, res) => {
    res.json(reports.updateSettlement(req.ctx, req.params.paymentId, req.body ?? {}));
  }));
  app.delete("/api/reports/settlement/:paymentId", wrap((req, res) => {
    res.json(reports.deleteSettlement(req.ctx, req.params.paymentId));
  }));
  app.get("/api/reports/card-settlement", wrap((req, res) => {
    return report(req, res, "cardSettlementReport",
      req.query.from ? String(req.query.from) : undefined,
      req.query.to ? String(req.query.to) : undefined,
      req.query.card ? String(req.query.card) : undefined,
    );
  }));
  app.get("/api/reports/card-settlement/:bookingId/bills", wrap((req, res) => {
    return report(req, res, "cardSettlementBills", req.params.bookingId);
  }));
  app.get("/api/reports/kot-cancellations", wrap((req, res) => {
    return report(req, res, "kotCancellationReport", {
      from: String(req.query.from ?? ""),
      to: String(req.query.to ?? ""),
      username: String(req.query.username ?? ""),
      tableNo: String(req.query.tableNo ?? ""),
      page: Number(req.query.page ?? 1),
    });
  }));
  app.get("/api/reports/kots", wrap((req, res) => {
    return report(req, res, "kotReport",
      req.query.from ? String(req.query.from) : undefined,
      req.query.to ? String(req.query.to) : undefined,
      req.query.station ? String(req.query.station) : undefined,
      {
        outlet: req.query.outlet ? String(req.query.outlet) : undefined,
        kotNo: req.query.kot ? String(req.query.kot) : undefined,
        tableNo: req.query.table ? String(req.query.table) : undefined,
        billNo: req.query.bill ? String(req.query.bill) : undefined,
        complementary: req.query.complementary ? String(req.query.complementary) : undefined,
      },
    );
  }));
  app.get("/api/reports/kots/:kotKey", wrap((req, res) => {
    return report(req, res, "kotDetail", String(req.params.kotKey));
  }));
  app.get("/api/reports/bills", wrap((req, res) => {
    const statusRaw = String(req.query.status || "all").toLowerCase();
    const status = statusRaw === "active" || statusRaw === "cancelled" ? statusRaw : "all";
    return report(req, res, "billReport",
      req.query.from ? String(req.query.from) : undefined,
      req.query.to ? String(req.query.to) : undefined,
      {
        outlet: req.query.outlet ? String(req.query.outlet) : undefined,
        billNo: req.query.bill ? String(req.query.bill) : undefined,
        tableNo: req.query.table ? String(req.query.table) : undefined,
        status,
        discountedOnly: req.query.discounted === "1" || req.query.discounted === "true",
        complimentaryOnly: req.query.complimentary === "1",
        complimentaryAccountId: typeof req.query.complimentaryAccountId === "string" ? req.query.complimentaryAccountId : undefined,
        complimentaryAccount: typeof req.query.complimentaryAccount === "string" ? req.query.complimentaryAccount : undefined,
      },
    );
  }));
  app.get("/api/bookings", wrap((req, res) => report(req, res, "listBookings")));
  app.post("/api/bookings", wrap((req, res) => res.json(reports.saveBooking(req.ctx, req.body ?? {}))));
  app.post("/api/reports/day-close", wrap((req, res) => res.json(reports.dayClose(req.ctx, req.body.date))));
  app.get("/api/audit", wrap((req, res) => report(req, res, "listAudit")));

  app.get("/api/sync", wrap((req, res) => res.json(sync.syncStatus(req.ctx))));
  app.post("/api/sync/flush", wrap(async (req, res) => res.json(await sync.flushSync(req.ctx))));

  app.get("/api/hardware/status", (req, res) => {
    const hw = req.ctx.hardware;
    res.json({
      rfid: hw.rfid.isConnected(),
      nfc: hw.nfc.isConnected(),
      barcode: hw.barcode.isConnected(),
      receipt: hw.receipt.isConnected(),
      kitchen: hw.kitchen.isConnected(),
      bar: hw.bar.isConnected(),
      drawer: hw.drawer.isConnected(),
      display: hw.display.isConnected(),
    });
  });
  app.post("/api/hardware/test-print", wrap(async (req, res) => {
    const target = req.body.target === "bar" ? req.ctx.hardware.bar : req.body.target === "kitchen" ? req.ctx.hardware.kitchen : req.ctx.hardware.receipt;
    res.json(await target.testPrint());
  }));

  if (process.env.NODE_ENV === "production") {
    const clientDir = process.env.POS_CLIENT_DIR
      ? path.resolve(process.env.POS_CLIENT_DIR)
      : path.resolve(process.cwd(), "dist/client");
    app.use(express.static(clientDir));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    const message = err instanceof Error ? err.message : "Server error";
    const status = message.startsWith("Permission denied") ? 403 : 400;
    res.status(status).json({ error: message });
  });

  return app;
}
