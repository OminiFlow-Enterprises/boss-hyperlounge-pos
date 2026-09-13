import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import type Database from "better-sqlite3";
import type { Actor } from "../../shared/types.js";
import { hasPermission, type Permission } from "../../shared/permissions.js";
import { AppError } from "../lib/errors.js";
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

export function createApp(options: CreateAppOptions) {
  const app = express();
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
      const actor = staff.login(req.ctx, req.body.username, req.body.pin, req.body.terminalId ?? req.ctx.actor.terminalId);
      currentActor = actor;
      res.json(actor);
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

  app.get("/api/cards/balance/check", wrap((req, res) => {
    res.json(cards.checkBalance(req.ctx, String(req.query.q ?? "")));
  }));
  app.get("/api/cards", wrap((req, res) => {
    if (req.query.q) {
      res.json(cards.searchCards(req.ctx, String(req.query.q)));
      return;
    }
    res.json(cards.listCards(req.ctx, req.query.status ? String(req.query.status) : undefined));
  }));
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
  app.get("/api/tables/waiter", wrap((req, res) => res.json(tables.waiterTables(req.ctx, req.ctx.actor.staffId))));
  app.post("/api/tables/:id/open", wrap((req, res) => {
    res.json(tables.openTable(req.ctx, { tableId: req.params.id, ...req.body }));
  }));
  app.post("/api/tables/:id/checkin", wrap((req, res) => {
    res.json(tables.checkIn(req.ctx, { tableId: req.params.id, ...req.body }));
  }));
  app.post("/api/tables/:id/request-bill", wrap((req, res) => res.json(tables.requestBill(req.ctx, req.params.id))));
  app.post("/api/tables/transfer", wrap((req, res) => {
    res.json(tables.transferTable(req.ctx, req.body.fromTableId, req.body.toTableId, req.body.reason));
  }));
  app.post("/api/tables/merge", wrap((req, res) => {
    res.json(tables.mergeTables(req.ctx, req.body.sourceTableId, req.body.targetTableId));
  }));
  app.post("/api/tables/split", wrap((req, res) => res.json(tables.splitTable(req.ctx, req.body))));

  app.get("/api/products", wrap((req, res) => res.json(staff.listProducts(req.ctx))));
  app.get("/api/orders", wrap((req, res) => res.json(orders.listOrders(req.ctx))));
  app.get("/api/orders/:id", wrap((req, res) => res.json(orders.getOrderDetail(req.ctx, req.params.id))));
  app.post("/api/orders", wrap((req, res) => res.json(orders.createOrder(req.ctx, req.body.tableId))));
  app.post("/api/orders/:id/items", wrap((req, res) => {
    res.json(orders.addItem(req.ctx, { orderId: req.params.id, ...req.body }));
  }));
  app.post("/api/orders/:id/send-kot", wrap(async (req, res) => {
    res.json(await orders.sendKot(req.ctx, req.params.id));
  }));
  app.post("/api/order-items/:id/qty", wrap((req, res) => {
    res.json(orders.modifyItemQty(req.ctx, req.params.id, Number(req.body.qty)));
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
    res.json(billing.previewBill(req.ctx, req.body.orderId, req.body));
  }));
  app.post("/api/invoices/generate", wrap((req, res) => {
    res.json(billing.generateInvoice(req.ctx, req.body.orderId, req.body));
  }));
  app.get("/api/invoices", wrap((req, res) => res.json(billing.listInvoices(req.ctx))));
  app.get("/api/invoices/:id", wrap((req, res) => res.json(billing.getInvoice(req.ctx, req.params.id))));
  app.post("/api/invoices/:id/pay", wrap((req, res) => {
    res.json(billing.settleInvoice(req.ctx, req.params.id, req.body.lines, req.body));
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
    res.json(reports.ownerDashboard(req.ctx, req.query.date ? String(req.query.date) : undefined));
  }));
  app.get("/api/reports/reconciliation", wrap((req, res) => {
    res.json(reports.reconcile(req.ctx, req.query.date ? String(req.query.date) : undefined));
  }));
  app.get("/api/reports/sales", wrap((req, res) => {
    res.json(reports.salesReport(req.ctx, req.query.date ? String(req.query.date) : undefined));
  }));
  app.post("/api/reports/day-close", wrap((req, res) => res.json(reports.dayClose(req.ctx, req.body.date))));
  app.get("/api/audit", wrap((req, res) => res.json(reports.listAudit(req.ctx))));

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
    const clientDir = path.resolve(process.cwd(), "dist/client");
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
