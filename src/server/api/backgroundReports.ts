import type { Request, Response } from "express";
import { startDatabaseWorker } from "../db/backgroundWorker.js";
import { AppError } from "../lib/errors.js";
import type { ReportArgs, ReportName } from "../services/reportWorker.js";
import * as reports from "../services/reportService.js";

const entry = new URL(import.meta.url.endsWith(".ts") ? "../services/reportWorker.ts" : "../services/reportWorker.js", import.meta.url);
const unavailable = "Could not load the report. Try again or choose a shorter date range.";
const workerLimit = 2;
const queueLimit = 3;
const reportTimeout = 30_000;

export function createBackgroundReports() {
  let active = 0;
  const waiting = new Set<() => void>();

  function acquire(res: Response): Promise<boolean> {
    if (res.destroyed) return Promise.resolve(false);
    if (active < workerLimit) {
      active++;
      return Promise.resolve(true);
    }
    if (waiting.size >= queueLimit) throw new AppError("Other reports are loading. Try again shortly.", 503);

    return new Promise((resolve, reject) => {
      function cleanup() {
        waiting.delete(start);
        clearTimeout(timer);
        res.off("close", disconnected);
      }
      function start() {
        cleanup();
        active++;
        resolve(true);
      }
      function disconnected() {
        cleanup();
        resolve(false);
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new AppError("The report queue is busy. Try again shortly.", 503));
      }, reportTimeout);
      waiting.add(start);
      res.once("close", disconnected);
    });
  }

  function release() {
    active--;
    waiting.values().next().value?.();
  }

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
    if (!(await acquire(res))) return;
    if (res.destroyed) {
      release();
      return;
    }
    let worker: ReturnType<typeof startDatabaseWorker>;
    try {
      worker = startDatabaseWorker(entry, { filename: db.name, actor, online, name, args });
    } catch (error) {
      release();
      console.error(`Could not start report ${name}:`, error);
      throw new AppError(unavailable, 503);
    }
    worker.once("exit", release);

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
      }, reportTimeout);
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
