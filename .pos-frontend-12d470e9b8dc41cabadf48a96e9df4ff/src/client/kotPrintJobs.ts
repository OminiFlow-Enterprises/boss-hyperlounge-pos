import { api, ApiError } from "./api";
import { printBillHtml } from "./printBillHtml";

type JobStatus = {
  status: "QUEUED" | "PRINTING" | "PRINTED" | "FAILED";
  destination?: string;
  kotNumber?: string;
  error?: string;
  html?: string;
  deviceName?: string;
};

const storageKey = "pos.pendingKotPrintJobs";
const pending = new Set<string>();
const completions = new Map<string, string | null>();
let polling = false;
let printingConnected = false;
let requestPoll: (() => void) | undefined;

try {
  const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
  if (Array.isArray(stored)) {
    for (const id of stored) if (typeof id === "string") pending.add(id);
  }
} catch {
  // Printing status can still be tracked for this session.
}

function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify([...pending])); } catch { /* storage unavailable */ }
}

export function trackKotPrintJobs(ids: string[]) {
  for (const id of ids) pending.add(id);
  if (ids.length) {
    persist();
    requestPoll?.();
  }
}

async function printConnected(path: string, id: string) {
  printingConnected = true;
  try {
    const job = await api.post<JobStatus>(path, { action: "claim" });
    if (job.html) {
      try {
        const result = job.deviceName && !window.bossPrint
          ? { ok: false, error: "Open the Windows POS Client on the Office PC to print to bill" }
          : await printBillHtml(job.html, job.deviceName ?? "");
        completions.set(id, result.ok ? null : result.error || "Connected printer failed");
      } catch (error) {
        completions.set(id, error instanceof Error ? error.message : "Connected printer failed");
      }
      return true;
    }
  } catch {
    // Poll again after a dropped response. If the claim was accepted, the server will time it out.
  } finally {
    printingConnected = false;
  }
  return false;
}

export function watchKotPrintJobs(onFailure: (message: string) => void) {
  let stopped = false;
  let pollRequested = false;

  function wake() {
    if (stopped) return;
    if (polling) pollRequested = true;
    else void poll();
  }

  async function poll() {
    if (stopped || !pending.size) return;
    polling = true;
    try {
      const failures: string[] = [];
      const jobs = await Promise.all([...pending].map(async (id) => {
        const path = `/api/kot-print-jobs/${encodeURIComponent(id)}`;
        try {
          const job = await api.post<JobStatus>(path, completions.has(id)
            ? { action: "finish", error: completions.get(id) }
            : undefined);
          if (job.status === "QUEUED" && (job.destination === "CONNECTED" || job.destination === "OFFICE LOCAL")) {
            return { id, path };
          }
          if (job.status === "PRINTED" || job.status === "FAILED") {
            pending.delete(id);
            completions.delete(id);
            persist();
            if (job.status === "FAILED") failures.push(`${job.kotNumber} · ${job.destination}: ${job.error || "Print failed"}`);
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            pending.delete(id);
            completions.delete(id);
            persist();
            failures.push("A print job could not be found. Check the printer before reprinting.");
          }
        }
      }));
      if (failures.length) onFailure(`KOT saved. ${failures.join("\n")}`);
      const next = jobs.find((job) => job !== undefined);
      if (next && !stopped && !printingConnected) {
        void printConnected(next.path, next.id).then((finished) => {
          if (finished) requestPoll?.();
        });
      }
    } finally {
      polling = false;
      if (pollRequested) {
        pollRequested = false;
        wake();
      } else if (stopped) {
        requestPoll?.();
      }
    }
  }

  requestPoll = wake;
  const timer = window.setInterval(wake, 1200);
  wake();
  return () => {
    stopped = true;
    if (requestPoll === wake) requestPoll = undefined;
    window.clearInterval(timer);
  };
}
