import { formatTableNo } from "../../shared/tableLabel.js";
import type { AppContext } from "../lib/context.js";

/** Table number printed and reported for an order. Club orders are `card/table`. */
export function printedTableNo(
  ctx: AppContext,
  input: { tableId: string; orderId?: string | null },
): string {
  const row = ctx.db
    .prepare(
      `SELECT t.code AS code,
              COALESCE(NULLIF(t.outlet, ''), 'BAR') AS outlet,
              (
                SELECT c.card_number FROM member_cards c
                 WHERE c.id = COALESCE(
                   (SELECT o.card_id FROM orders o WHERE o.id = ?),
                   (SELECT s.card_id FROM table_sessions s
                     WHERE s.id = (SELECT o.session_id FROM orders o WHERE o.id = ?)),
                   (SELECT s.card_id FROM table_sessions s WHERE s.id = t.current_session_id)
                 )
              ) AS card_number
         FROM dining_tables t
        WHERE t.id = ?`,
    )
    .get(input.orderId || "", input.orderId || "", input.tableId) as
    | { code: string; outlet: string; card_number: string | null }
    | undefined;
  if (!row) return "";
  return formatTableNo(row.code, row.card_number, row.outlet);
}
