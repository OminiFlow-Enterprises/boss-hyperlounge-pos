import { openDatabase } from "../src/server/db/database.js";
import { seedFresh } from "../src/server/db/seed.js";
import { createHardware } from "../src/server/hardware/index.js";
import type { AppContext } from "../src/server/lib/context.js";
import type { Actor, StaffRole } from "../src/shared/types.js";

export function createTestApp() {
  const db = openDatabase({ memory: true });
  const seeded = seedFresh(db);
  const hardware = createHardware();

  const actorFor = (roleKey: keyof typeof seeded.staff): Actor => {
    const row = db.prepare("SELECT * FROM staff WHERE id = ?").get(seeded.staff[roleKey as string]) as {
      id: string;
      name: string;
      role: StaffRole;
    };
    return {
      staffId: row.id,
      staffName: row.name,
      role: row.role,
      terminalId: seeded.terminals.pos,
      terminalName: "POS-01",
    };
  };

  const ctx = (role: keyof typeof seeded.staff = "cashier"): AppContext => ({
    db,
    actor: actorFor(role),
    hardware,
    online: false,
  });

  return { db, seeded, hardware, ctx, actorFor };
}
