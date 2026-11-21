import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { AppError } from "../lib/errors.js";
import type { AppContext } from "../lib/context.js";
import * as reports from "./reportService.js";

const readReports = {
  billReport: reports.billReport,
  cardSettlementBills: reports.cardSettlementBills,
  cardSettlementReport: reports.cardSettlementReport,
  gstBillWise: reports.gstBillWise,
  gstTaxSummary: reports.gstTaxSummary,
  itemTransferReport: reports.itemTransferReport,
  itemWiseSales: reports.itemWiseSales,
  kotDetail: reports.kotDetail,
  kotCancellationReport: reports.kotCancellationReport,
  kotReport: reports.kotReport,
  listAudit: reports.listAudit,
  listBookings: reports.listBookings,
  ownerDashboard: reports.ownerDashboard,
  reconcile: reports.reconcile,
  salesReport: reports.salesReport,
  settlementDetail: reports.settlementDetail,
  settlementReport: reports.settlementReport,
  tableTransferReport: reports.tableTransferReport,
};

export type ReportName = keyof typeof readReports;
export type ReportArgs<N extends ReportName> = Parameters<typeof readReports[N]> extends [AppContext, ...infer Args] ? Args : never;

const { filename, actor, online, name, args } = workerData.data as {
  filename: string;
  actor: AppContext["actor"];
  online: boolean;
  name: ReportName;
  args: unknown[];
};
try {
  const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    const execute = readReports[name] as (ctx: Pick<AppContext, "db" | "actor" | "online">, ...args: unknown[]) => unknown;
    const json = db.transaction(() => JSON.stringify(execute({ db, actor, online }, ...args)))();
    parentPort!.postMessage({ json });
  } finally {
    db.close();
  }
} catch (error) {
  if (!(error instanceof AppError)) throw error;
  parentPort!.postMessage({ error: { message: error.message, status: error.status, code: error.code, details: error.details } });
}
