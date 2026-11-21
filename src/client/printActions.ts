import type { KeyboardEvent } from "react";
import { api } from "./api";
import { handleBillPrintResponse, type BillPrintApiResult } from "./printBillHtml";

const PRINT_COOLDOWN_MS = 500;
const printJobs = new Map<string, Promise<unknown>>();

function runPrintJob<T>(key: string, print: () => T | Promise<T>): Promise<T> {
  const existing = printJobs.get(key);
  if (existing) return existing as Promise<T>;

  const job = Promise.resolve().then(print).then(
    (result) => {
      window.setTimeout(() => printJobs.delete(key), PRINT_COOLDOWN_MS);
      return result;
    },
    (error: unknown) => {
      printJobs.delete(key);
      throw error;
    },
  );
  printJobs.set(key, job);
  return job;
}

export function printBill(id: string) {
  return runPrintJob(`bill:${id}`, async () => {
    const result = await api.post<BillPrintApiResult>(`/api/invoices/${id}/print`);
    return handleBillPrintResponse(result);
  });
}

export function reprintKot(id: string) {
  return runPrintJob(`kot:${id}`, () => api.post(`/api/kots/${id}/reprint`));
}

export function printPage() {
  return runPrintJob("page", () => window.print());
}

export function ignoreRepeatedPrintKey(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
}
