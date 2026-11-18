/** Bill footer rows under Total — match THE BOSS slip sequence. Money is paise. */

export type BillLineForTax = {
  amount: number;
  taxRate: number;
  salesGroup?: string | null;
};

export type BillTotalLine = {
  label: string;
  base?: number;
  amount: number;
};

function isFreeGroup(salesGroup: string | null | undefined): boolean {
  const u = String(salesGroup ?? "").toUpperCase();
  if (!u) return false;
  if (u.includes("VOLUNTARY")) return false;
  return u.includes("TAX FREE") || u.includes("GST FREE") || u.includes("FREE");
}

function isVatGroup(salesGroup: string | null | undefined, taxRate: number): boolean {
  if (taxRate <= 0 || isFreeGroup(salesGroup)) return false;
  return String(salesGroup ?? "").toUpperCase().includes("VAT");
}

function isGstGroup(salesGroup: string | null | undefined, taxRate: number): boolean {
  if (taxRate <= 0 || isFreeGroup(salesGroup)) return false;
  if (isVatGroup(salesGroup, taxRate)) return false;
  return true;
}

function fmtPct(rate: number, decimals: number): string {
  return (Number(rate) || 0).toFixed(decimals);
}

type Acc = { base: number; tax: number; rate: number };

function addAcc(map: Map<number, Acc>, rate: number, base: number, tax: number) {
  const cur = map.get(rate) ?? { base: 0, tax: 0, rate };
  cur.base += base;
  cur.tax += tax;
  map.set(rate, cur);
}

/** Print VAT group rate: IBS slip shows Vat 20% even when master is VAT @ 24%. */
function vatPrintRate(rate: number): number {
  return Math.abs(rate - 24) < 0.001 ? 20 : rate;
}

/** VAT @ 24% prints as Vat 20% + separate Surcharge (4% of base / 20% of VAT amount). */
function pushVatAndSurcharge(rows: BillTotalLine[], v: Acc) {
  if (!v.tax && !v.base) return;
  const printRate = vatPrintRate(v.rate);
  if (Math.abs(v.rate - 24) < 0.001) {
    const vatAmount = Math.round((v.base * 20) / 100);
    const surchargeAmount = Math.max(0, v.tax - vatAmount);
    rows.push({
      label: `Vat ${fmtPct(printRate, printRate % 1 === 0 ? 0 : 1)}%`,
      base: v.base,
      amount: vatAmount,
    });
    if (surchargeAmount > 0) {
      rows.push({
        label: "Surcharge",
        base: vatAmount,
        amount: surchargeAmount,
      });
    }
    return;
  }
  rows.push({
    label: `Vat ${fmtPct(printRate, printRate % 1 === 0 ? 0 : 1)}%`,
    base: v.base,
    amount: v.tax,
  });
}

/**
 * Sequence (native slip / cashier):
 * Discount → S.C. VOLUNTARY 10 % → Vat 20% → Surcharge → CGST % → SGST % → Delivery → Round Off
 */
export function buildBillTotalLines(input: {
  lines: BillLineForTax[];
  discount: number;
  discountPct: number;
  serviceCharge: number;
  serviceChargePct: number;
  otherCharges: number;
  roundOff: number;
  /** Prefer invoice tax total when present (keeps print aligned with settled bill). */
  taxTotal?: number;
}): BillTotalLine[] {
  const rows: BillTotalLine[] = [];
  const discount = Math.max(0, Math.round(input.discount || 0));
  const discountPct = Number(input.discountPct) || 0;

  if (discount > 0 || discountPct > 0) {
    rows.push({
      label: `Discount ${fmtPct(discountPct, 2)} %`,
      amount: discount,
    });
  }

  const subtotal = input.lines.reduce((s, l) => s + Math.max(0, l.amount), 0);
  const vatByRate = new Map<number, Acc>();
  const gstByRate = new Map<number, Acc>();
  const otherByRate = new Map<number, Acc>();

  let allocatedDisc = 0;
  const positive = input.lines.filter((l) => l.amount > 0);

  for (let i = 0; i < positive.length; i++) {
    const line = positive[i];
    const rate = Number(line.taxRate) || 0;
    const isLast = i === positive.length - 1;
    let lineDisc = 0;
    if (discount > 0 && subtotal > 0) {
      lineDisc = isLast
        ? Math.max(0, discount - allocatedDisc)
        : Math.round((discount * line.amount) / subtotal);
      if (lineDisc > line.amount) lineDisc = line.amount;
      allocatedDisc += lineDisc;
    }
    const base = Math.max(0, line.amount - lineDisc);
    const tax = Math.round((base * rate) / 100);
    if (rate <= 0) continue;

    if (isVatGroup(line.salesGroup, rate)) addAcc(vatByRate, rate, base, tax);
    else if (isGstGroup(line.salesGroup, rate)) addAcc(gstByRate, rate, base, tax);
    else addAcc(otherByRate, rate, base, tax);
  }

  if (input.taxTotal != null && input.taxTotal > 0) {
    const buckets = [...vatByRate.values(), ...gstByRate.values(), ...otherByRate.values()];
    const computed = buckets.reduce((s, v) => s + v.tax, 0);
    if (computed > 0 && computed !== input.taxTotal) {
      const factor = input.taxTotal / computed;
      for (const v of buckets) v.tax = Math.round(v.tax * factor);
      let sum = buckets.reduce((s, v) => s + v.tax, 0);
      const drift = input.taxTotal - sum;
      if (drift !== 0) {
        const prefer = [...buckets].sort((a, b) => b.tax - a.tax)[0];
        if (prefer) prefer.tax += drift;
      }
    }
  }

  // 10% service charge prints as S.C. VOLUNTARY (not "Service Charge" / "Surcharge 10%")
  if (input.serviceCharge > 0) {
    const scPct = Number(input.serviceChargePct) || 10;
    rows.push({
      label: `S.C. VOLUNTARY ${fmtPct(scPct, scPct % 1 === 0 ? 0 : 2)} %`,
      amount: input.serviceCharge,
    });
  }

  for (const v of [...vatByRate.values()].sort((a, b) => a.rate - b.rate)) {
    pushVatAndSurcharge(rows, v);
  }

  // Unknown non-VAT/GST rates: show as Vat-style so % still prints
  for (const v of [...otherByRate.values()].sort((a, b) => a.rate - b.rate)) {
    pushVatAndSurcharge(rows, v);
  }

  // Display CGST/SGST as equal halves; odd paise goes to Round Off (not shown as 265.53/265.52).
  let gstOddPaise = 0;

  // No per-line rates available: still print CGST/SGST with % from the invoice tax total
  if (
    input.taxTotal != null &&
    input.taxTotal > 0 &&
    vatByRate.size === 0 &&
    gstByRate.size === 0 &&
    otherByRate.size === 0
  ) {
    const half = Math.floor(input.taxTotal / 2);
    gstOddPaise += input.taxTotal - half * 2;
    rows.push({ label: "CGST 9.0%", amount: half });
    rows.push({ label: "SGST 9.0%", amount: half });
  }

  for (const g of [...gstByRate.values()].sort((a, b) => a.rate - b.rate)) {
    if (!g.tax && !g.base) continue;
    const halfRate = g.rate / 2;
    const half = Math.floor(g.tax / 2);
    gstOddPaise += g.tax - half * 2;
    rows.push({
      label: `CGST ${fmtPct(halfRate, 1)}%`,
      base: g.base,
      amount: half,
    });
    rows.push({
      label: `SGST ${fmtPct(halfRate, 1)}%`,
      base: g.base,
      amount: half,
    });
  }

  if (input.otherCharges > 0) {
    rows.push({ label: "Delivery Charge", amount: input.otherCharges });
  }
  const roundOff = (input.roundOff || 0) + gstOddPaise;
  if (roundOff !== 0) {
    rows.push({ label: "Round Off", amount: roundOff });
  }

  return rows;
}
