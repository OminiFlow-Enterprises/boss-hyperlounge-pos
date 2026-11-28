/** All money is stored as integer paise. ₹1.00 = 100. */

export const PAISE = 100;

export function serviceChargeGst(serviceCharge: number): number {
  return Math.round((Math.max(0, serviceCharge) * 18) / 100);
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * PAISE);
}

export function paiseToRupees(paise: number): number {
  return paise / PAISE;
}

export function formatINR(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / PAISE);
  const remainder = abs % PAISE;
  const grouped = rupees.toLocaleString("en-IN");
  return `${sign}₹${grouped}.${remainder.toString().padStart(2, "0")}`;
}

export function parseRupeesInput(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid amount");
    return rupeesToPaise(value);
  }
  const cleaned = value.replace(/[₹,\s]/g, "").trim();
  if (!cleaned) throw new Error("Amount is required");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid amount");
  return rupeesToPaise(n);
}

export function assertPositiveAmount(paise: number, label = "Amount"): void {
  if (!Number.isInteger(paise) || paise <= 0) {
    throw new Error(`${label} must be a positive amount`);
  }
}

/** Allocate the bill discount before rounding the tax on each item line. */
export function billLineTaxes(
  lines: Array<{ amount: number; taxRate: number; excluded: boolean }>,
  discount: number,
  discountable: number,
): number[] {
  const eligible = lines.filter((line) => !line.excluded && line.amount > 0);
  const last = eligible[eligible.length - 1];
  let allocated = 0;
  return lines.map((line) => {
    let share = 0;
    if (!line.excluded && line.amount > 0 && discount > 0 && discountable > 0) {
      share = Math.min(line.amount, line === last
        ? Math.max(0, discount - allocated)
        : Math.round((discount * line.amount) / discountable));
      allocated += share;
    }
    return Math.round((Math.max(0, line.amount - share) * line.taxRate) / 100);
  });
}
