import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import type Database from "better-sqlite3";
import type { Actor, BillDetails, BillLineEdit, ServiceChargeMode } from "../../shared/types.js";
import { billApprovalFields } from "../../shared/billApproval.js";
import { hasPermission, type Permission } from "../../shared/permissions.js";
import { AppError } from "../lib/errors.js";
import { createBackgroundReports } from "./backgroundReports.js";
import type { AppContext } from "../lib/context.js";
import { createHardware, type HardwareBus } from "../hardware/index.js";
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

function applyBillEdits(ctx: AppContext, orderId: string, edits: BillLineEdit[], allowPaid: boolean) {
  for (const edit of edits) {
    switch (edit.kind) {
      case "add":
        if (!/^bill-[0-9a-f]{32}$/.test(edit.id)) throw new AppError("Invalid bill item ID");
        orders.addItem(ctx, { orderId, ...edit }, { id: edit.id, allowPaid });
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
  let currentActor: Actor | null = null;
  let online = options.online ?? true;

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

  app.use((req, _res, next) => {
    req.ctx = {
      db: options.db,
      actor: currentActor ?? guestActor(),
      hardware,
      online,
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

  app.post(
    "/api/auth/login",
    wrap((req, res) => {
      const actor = staff.login(
        req.ctx,
        req.body.username,
        req.body.password ?? req.body.pin,
        req.body.terminalId ?? req.ctx.actor.terminalId,
      );
      currentActor = actor;
      res.json(actor);
    }),
  );

  app.post("/api/auth/logout", (_req, res) => {
    currentActor = null;
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
    res.json({ actor: req.ctx.actor, online: req.ctx.online, sync: sync.syncStatus(req.ctx) });
  });

  app.post("/api/session/online", (req, res) => {
    online = Boolean(req.body.online);
    res.json({ online });
  });

  app.get("/api/bootstrap", wrap((req, res) => {
    res.json({
      actor: req.ctx.actor,
      floors: tables.listFloors(req.ctx),
      tables: tables.listTables(req.ctx),
      products: staff.listProducts(req.ctx),
      cardTypes: staff.listCardTypes(req.ctx),
      staff: staff.listStaff(req.ctx),
      settings: settings.getAllSettings(req.ctx),
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
  app.post("/api/tables", wrap((req, res) => res.json(tables.createTable(req.ctx, req.body ?? {}))));
  app.get("/api/tables/waiter", wrap((req, res) => res.json(tables.waiterTables(req.ctx, req.ctx.actor.staffId))));
  app.post("/api/tables/:id/open", wrap((req, res) => {
    res.json(tables.openTable(req.ctx, { tableId: req.params.id, ...req.body }));
  }));
  app.post("/api/tables/:id/card", wrap((req, res) => {
    res.json(tables.attachTableCard(req.ctx, req.params.id, String(req.body?.cardNumber ?? "")));
  }));
  app.post("/api/tables/:id/checkin", wrap((req, res) => {
    res.json(tables.checkIn(req.ctx, { tableId: req.params.id, ...req.body }));
  }));
  app.post("/api/tables/:id/request-bill", wrap((req, res) => res.json(tables.requestBill(req.ctx, req.params.id))));
  app.post("/api/tables/transfer", wrap((req, res) => {
    res.json(tables.transferTable(req.ctx, req.body.fromTableId, req.body.toTableId, req.body.reason));
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
  app.get("/api/orders/:id", wrap((req, res) => res.json(orders.getOrderDetail(req.ctx, req.params.id))));
  app.post("/api/orders", wrap((req, res) => res.json(orders.createOrder(req.ctx, req.body.tableId))));
  app.post("/api/orders/:id/estimate", wrap((req, res) => {
    const orderId = req.params.id;
    const { items, outlet } = req.body;
    if (!Array.isArray(items)) throw new AppError("Items are required");
    const rollback = new Error("Estimate complete");
    let grandTotal = 0;
    try {
      req.ctx.db.transaction(() => {
        for (const { productId, qty, notes } of items) {
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
    res.json(orders.addItem(req.ctx, { orderId: req.params.id, ...req.body }));
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
    const remark = typeof req.body?.remark === "string" ? req.body.remark : undefined;
    const steward = typeof req.body?.steward === "string" ? req.body.steward : undefined;
    const cardNumber = typeof req.body?.cardNumber === "string" ? req.body.cardNumber : undefined;
    res.json(await orders.sendKot(req.ctx, req.params.id, { remark, steward, cardNumber }));
  }));
  app.post("/api/order-items/:id/qty", wrap((req, res) => {
    res.json(orders.modifyItemQty(req.ctx, req.params.id, Number(req.body.qty)));
  }));
  app.post("/api/order-items/:id/notes", wrap((req, res) => {
    res.json(orders.setItemNotes(req.ctx, req.params.id, String(req.body?.notes ?? "")));
  }));
  app.post("/api/order-items/:id/cancel", wrap((req, res) => {
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
    const expectedPin = process.env.POS_MASTER_PIN || "0166";
    if (masterPin && masterPin !== expectedPin) {
      throw new AppError("Incorrect master PIN", 403);
    }
    const invoice = req.ctx.db.transaction(() => {
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
      };
      const discountChanged = billOptions.discount != null || billOptions.discountPct != null || billOptions.discountFrom != null;
      const discountPct = discountChanged
        ? (billOptions.discountFrom === "amount" ? undefined : billOptions.discountPct)
        : savedDetails.discountPct;
      const submittedRemark = billOptions.billDetails?.remark;
      const remarkValue = billOptions.reason ?? (submittedRemark === savedDetails.remark ? undefined : submittedRemark);
      const remark = typeof remarkValue === "string" ? remarkValue.trim() : "";
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
        excludeItemIds: billOptions.excludeItemIds ?? billOptions.billDetails?.excludeItemIds ?? savedDetails.excludeItemIds,
        otherCharges: billOptions.otherCharges ?? existing?.other_charges,
        serviceChargeMode: billOptions.serviceChargeMode ?? existing?.service_charge_mode,
        serviceChargePct: billOptions.serviceChargePct ??
          (existing && (existing.service_charge_pct || !existing.service_charge) ? existing.service_charge_pct : 10),
      };
      if (!finalOptions.complimentary) finalOptions.complimentaryAccountId = undefined;
      finalOptions.billDetails.excludeItemIds = finalOptions.excludeItemIds;
      const needsApproval = edits.length || billApprovalFields({
        ...savedFields,
        ...finalOptions,
      }) !== billApprovalFields(savedFields);
      if (needsApproval) {
        if (!remark) throw new AppError("Enter a remark to update this bill", 403, "BILL_REMARK_REQUIRED", "billRemark");
        if (!masterPin) {
          throw new AppError("Enter the master PIN to update this bill", 403);
        }
      }
      applyBillEdits(req.ctx, orderId, edits, existing?.status === "PAID");
      return billing.generateInvoice(req.ctx, orderId, {
        ...finalOptions,
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

  app.get("/api/settings", wrap((req, res) => res.json(settings.getAllSettings(req.ctx))));
  app.put("/api/settings", requirePerm("SETTINGS"), wrap((req, res) => {
    for (const [key, value] of Object.entries(req.body ?? {})) {
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
