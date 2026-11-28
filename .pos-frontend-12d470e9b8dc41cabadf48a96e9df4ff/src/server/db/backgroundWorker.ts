import { Worker } from "node:worker_threads";

export function startDatabaseWorker(entry: URL, workerData: unknown) {
  if (entry.pathname.endsWith(".ts")) {
    // Development runs the server directly from TypeScript through tsx.
    return new Worker(
      'require("tsx/esm/api").tsImport(require("node:worker_threads").workerData.entry, require("node:url").pathToFileURL(__filename).href).catch(error => { throw error; })',
      { eval: true, workerData: { entry: entry.href, data: workerData }, execArgv: [] },
    );
  }
  return new Worker(entry, { workerData: { data: workerData }, execArgv: [] });
}
