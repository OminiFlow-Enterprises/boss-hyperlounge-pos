import type { BillDetails } from "./types.js";

type BillFields = {
  billDetails?: Partial<BillDetails>;
  customerDisplayName?: string;
  customerGstin?: string;
  complimentaryAccountId?: string | null;
  otherCharges?: number;
  discount?: number;
  discountPct?: number;
  excludeItemIds?: string[];
};

export function billApprovalFields(bill: BillFields) {
  const details = bill.billDetails;
  const discountPct = Number(bill.discountPct ?? details?.discountPct ?? 0);
  return JSON.stringify({
    name: bill.customerDisplayName?.trim() ?? "",
    gstin: bill.customerGstin?.trim() ?? "",
    mobile: details?.mobile?.trim() ?? "",
    pax: details?.pax?.trim() || "1",
    address: details?.address?.trim() ?? "",
    remark: details?.remark?.trim() ?? "",
    complimentaryAccountId: bill.complimentaryAccountId || "",
    otherCharges: Number(bill.otherCharges ?? 0),
    discountPct,
    discount: discountPct ? 0 : Number(bill.discount ?? 0),
    excludeItemIds: [...new Set(bill.excludeItemIds ?? details?.excludeItemIds ?? [])].sort(),
  });
}
