import type { Request, Response } from "express";
import { startDatabaseWorker } from "../db/backgroundWorker.js";
import { AppError } from "../lib/errors.js";
import type { ReportArgs, ReportName } from "../services/reportWorker.js";
import * as reports from "../services/reportService.js";

const entry = new URL(import.meta.url.endsWith(".ts") ? "../services/reportWorker.ts" : "../services/reportWorker.js", import.meta.url);
const unavailable = "Could not load the report. Try again or choose a shorter date range.";

export function createBackgroundReports() {
  let active = 0;
  return async function report<N extends ReportName>(
    req: Request,
    res: Response,
    name: N,
    ...args: ReportArgs<N>
  ) {
    const { db, actor, online } = req.ctx;
    if (db.memory) {
      const execute = reports[name] as (ctx: Request["ctx"], ...values: unknown[]) => unknown;
      res.json(execute(req.ctx, ...args));
      return;
    }
    if (active >= 2) throw new AppError("Other reports are loading. Try again shortly.", 503);
    const worker = startDatabaseWorker(entry, { filename: db.name, actor, online, name, args });
    active++;
    worker.once("exit", () => { active--; });

    const json = await new Promise<string | undefined>((resolve, reject) => {
      function stop() {
        clearTimeout(timer);
        res.off("close", disconnected);
      }
      function disconnected() {
        stop();
        void worker.terminate();
        resolve(undefined);
      }
      const timer = setTimeout(() => {
        stop();
        void worker.terminate();
        reject(new AppError(unavailable, 504));
      }, 30_000);
      res.once("close", disconnected);
      worker.once("error", (error) => {
        stop();
        console.error(`Report ${name} failed:`, error);
        reject(new AppError(unavailable, 503));
      });
      worker.once("exit", () => {
        stop();
        if (!res.headersSent) reject(new AppError(unavailable, 503));
      });
      worker.once("message", ({ json, error }) => {
        stop();
        if (error) reject(new AppError(error.message, error.status, error.code, error.details));
        else resolve(json);
      });
    });
    if (json !== undefined && !res.destroyed) res.type("application/json").send(json);
  };
}
