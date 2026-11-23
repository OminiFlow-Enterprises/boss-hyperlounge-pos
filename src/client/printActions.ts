import type { KeyboardEvent } from "react";
import { api } from "./api";
import { handleBillPrintResponse, printBillHtml, type BillPrintApiResult } from "./printBillHtml";

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

export type KotPrintResponse = { error?: string; clientPrintHtml?: string[]; officePrintHtml?: string[] };

export async function finishKotPrinting(results: KotPrintResponse[]) {
  const errors: string[] = [];
  for (const result of results) {
    if (result.error) errors.push(result.error);
    const jobs = [
      ...(result.clientPrintHtml ?? []).map((html) => ({ html, queue: "" })),
      ...(result.officePrintHtml ?? []).map((html) => ({ html, queue: "bill" })),
    ];
    for (const { html, queue } of jobs) {
      try {
        const printed = queue && !window.bossPrint
          ? { ok: false, error: "Open the Windows POS Client on the Office PC to print to bill" }
          : await printBillHtml(html, queue);
        if (!printed.ok) errors.push(printed.error || "Connected printer failed");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Connected printer failed");
      }
    }
  }
  return errors.join(". ");
}

export function reprintKot(id: string) {
  return runPrintJob(`kot:${id}`, async () => {
    const result = await api.post<KotPrintResponse>(`/api/kots/${id}/reprint`);
    const error = await finishKotPrinting([result]);
    if (error) throw new Error(error);
    return { ...result, ok: !error, error };
  });
}

export function printPage() {
  return runPrintJob("page", () => window.print());
}

export function ignoreRepeatedPrintKey(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
}
