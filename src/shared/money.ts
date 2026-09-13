/** All money is stored as integer paise. ₹1.00 = 100. */

export const PAISE = 100;

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
