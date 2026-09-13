import type { AppContext } from "../lib/context.js";

export interface PriceResolution {
  productId: string;
  basePrice: number;
  unitPrice: number;
  source: "HAPPY_HOUR" | "MEMBERSHIP" | "BASE";
  taxRate: number;
  name: string;
  station: "KITCHEN" | "BAR";
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function currentMinutes(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

export function resolvePrice(
  ctx: AppContext,
  productId: string,
  cardTypeId: string | null,
  at = new Date(),
): PriceResolution {
  const product = ctx.db
    .prepare("SELECT id, name, station, base_price, tax_rate FROM products WHERE id = ? AND active = 1")
    .get(productId) as
    | { id: string; name: string; station: "KITCHEN" | "BAR"; base_price: number; tax_rate: number }
    | undefined;
  if (!product) throw new Error("Product not found");

  const dow = at.getDay() === 0 ? 7 : at.getDay();
  const nowMin = currentMinutes(at);
  const happy = ctx.db
    .prepare(
      `SELECT hh.id, hh.start_time, hh.end_time, hp.price
       FROM happy_hours hh
       JOIN happy_hour_prices hp ON hp.happy_hour_id = hh.id
       WHERE hh.active = 1 AND hp.product_id = ?`,
    )
    .all(productId) as Array<{ id: string; start_time: string; end_time: string; price: number }>;

  for (const rule of happy) {
    const days = ctx.db
      .prepare("SELECT days_of_week FROM happy_hours WHERE id = ?")
      .get(rule.id) as { days_of_week: string };
    const allowed = days.days_of_week.split(",").map((d) => Number(d.trim()));
    if (!allowed.includes(dow)) continue;
    const start = minutes(rule.start_time);
    const end = minutes(rule.end_time);
    const inWindow = start <= end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
    if (inWindow) {
      return {
        productId,
        basePrice: product.base_price,
        unitPrice: rule.price,
        source: "HAPPY_HOUR",
        taxRate: product.tax_rate,
        name: product.name,
        station: product.station,
      };
    }
  }

  if (cardTypeId) {
    const membership = ctx.db
      .prepare("SELECT price FROM product_prices WHERE product_id = ? AND card_type_id = ?")
      .get(productId, cardTypeId) as { price: number } | undefined;
    if (membership) {
      return {
        productId,
        basePrice: product.base_price,
        unitPrice: membership.price,
        source: "MEMBERSHIP",
        taxRate: product.tax_rate,
        name: product.name,
        station: product.station,
      };
    }

    const type = ctx.db
      .prepare("SELECT product_discount_pct FROM card_types WHERE id = ?")
      .get(cardTypeId) as { product_discount_pct: number } | undefined;
    if (type && type.product_discount_pct > 0) {
      const discounted = Math.round(product.base_price * (1 - type.product_discount_pct / 100));
      return {
        productId,
        basePrice: product.base_price,
        unitPrice: discounted,
        source: "MEMBERSHIP",
        taxRate: product.tax_rate,
        name: product.name,
        station: product.station,
      };
    }
  }

  return {
    productId,
    basePrice: product.base_price,
    unitPrice: product.base_price,
    source: "BASE",
    taxRate: product.tax_rate,
    name: product.name,
    station: product.station,
  };
}
