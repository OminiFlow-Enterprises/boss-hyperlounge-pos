import type Database from "better-sqlite3";
import type { Actor } from "../../shared/types.js";
import type { HardwareBus } from "../hardware/index.js";

export interface AppContext {
  db: Database.Database;
  actor: Actor;
  hardware: HardwareBus;
  online: boolean;
}

export function withActor(ctx: AppContext, actor: Actor): AppContext {
  return { ...ctx, actor };
}
