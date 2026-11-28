export const DEFAULT_BANK_PAYMENT_ACCOUNT = "Bank payment";

export function cleanPaymentReference(method?: string, reference?: string | null) {
  return method === "MEMBER_CARD" && reference?.trim() === "\\" ? null : reference;
}

export const BANK_PAYMENT_ACCOUNTS = [
  DEFAULT_BANK_PAYMENT_ACCOUNT, "BOOK MY SHOW", "COUPON", "PARTYPAL", "DISTRICT",
  "SWIGGY", "MOBIKWIK", "INDUS", "HDFC", "EAZYDINNER", "DINEOUT", "PAYTM", "ZOMATO",
] as const;
