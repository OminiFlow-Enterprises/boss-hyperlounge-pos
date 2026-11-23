import type Database from "better-sqlite3";
import type { HardwareBus, KotPrintPayload } from "../hardware/index.js";
import { formatKotHtml } from "../hardware/kotReceiptHtml.js";
import { AppError } from "../lib/errors.js";
import { uuid } from "../lib/ids.js";

const clientTimeout = 120_000;

export function kotPrinters(hardware: HardwareBus) {
  return { KITCHEN: hardware.kitchen, BAR: hardware.bar, "CAFE BAR": hardware.cafeBar, OFFICE: hardware.office };
}

type Job = {
  id: string;
  destination: keyof ReturnType<typeof kotPrinters> | "CONNECTED" | "OFFICE LOCAL";
  payload: string;
  status: "QUEUED" | "PRINTING" | "PRINTED" | "FAILED";
  error: string | null;
};

export function enqueueKotPrint(db: Database.Database, kotId: string, payload: KotPrintPayload) {
  const id = uuid();
  const now = Date.now();
  db.prepare(`INSERT INTO kot_print_jobs (id, kot_id, destination, payload, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(id, kotId, payload.station, JSON.stringify(payload), now, now);
  return id;
}

function claim(db: Database.Database, id: string) {
  return db.prepare("UPDATE kot_print_jobs SET status = 'PRINTING', updated_at = ? WHERE id = ? AND status = 'QUEUED'")
    .run(Date.now(), id).changes === 1;
}

function finish(db: Database.Database, id: string, error: string | null) {
  db.prepare("UPDATE kot_print_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'PRINTING'")
    .run(error === null ? "PRINTED" : "FAILED", error, Date.now(), id);
}

export function getKotPrintJob(db: Database.Database, id: string, action?: unknown, printError?: unknown, officeTerminal = false) {
  const job = db.prepare("SELECT * FROM kot_print_jobs WHERE id = ?").get(id) as Job | undefined;
  if (!job) throw new AppError("Print job not found", 404);
  if (job.destination === "OFFICE LOCAL" && !officeTerminal) throw new AppError("Print job not found", 404);
  if (job.destination === "CONNECTED" || job.destination === "OFFICE LOCAL") {
    if (action === "claim" && claim(db, id)) {
      return { status: "PRINTING", html: formatKotHtml(JSON.parse(job.payload)), deviceName: job.destination === "OFFICE LOCAL" ? "bill" : "" };
    }
    if (action === "finish") {
      finish(db, id, typeof printError === "string" && printError ? printError.slice(0, 1000) : null);
    }
  }
  const result = db.prepare(`SELECT j.status, j.destination, j.error, k.kot_number AS kotNumber
    FROM kot_print_jobs j JOIN kots k ON k.id = j.kot_id WHERE j.id = ?`).get(id);
  return result;
}

export function createKotPrintWorker(db: Database.Database, hardware: HardwareBus) {
  const printers = kotPrinters(hardware);
  const active = new Set<string>();
  // A process may have stopped after handing a job to Windows. Surface the uncertainty and avoid a duplicate.
  db.prepare(`UPDATE kot_print_jobs SET status = 'FAILED', updated_at = ?,
    error = 'POS restarted during printing. Check the printer before reprinting.' WHERE status = 'PRINTING'`).run(Date.now());

  async function tick() {
    const now = Date.now();
    db.prepare(`UPDATE kot_print_jobs SET status = 'FAILED', updated_at = ?,
      error = 'The originating terminal did not confirm printing. Check the printer before reprinting.'
      WHERE destination IN ('CONNECTED', 'OFFICE LOCAL') AND status IN ('QUEUED', 'PRINTING') AND updated_at < ?`)
      .run(now, now - clientTimeout);
    await Promise.all(Object.entries(printers).map(async ([destination, printer]) => {
      if (active.has(destination)) return;
      const job = db.prepare(`SELECT id, payload FROM kot_print_jobs WHERE status = 'QUEUED' AND destination = ?
        ORDER BY created_at, rowid LIMIT 1`).get(destination) as Pick<Job, "id" | "payload"> | undefined;
      if (!job || !claim(db, job.id)) return;
      active.add(destination);
      try {
        const result = printer
          ? await printer.printKOT(JSON.parse(job.payload))
          : { ok: false, error: "Printer queue is not configured" };
        finish(db, job.id, result.ok ? null : result.error || "Print failed");
      } catch (error) {
        finish(db, job.id, error instanceof Error ? error.message : "Print failed");
      } finally {
        active.delete(destination);
      }
    }));
  }
  return tick;
}
