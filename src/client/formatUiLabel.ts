const ACRONYMS = new Set(["BTC", "GST", "KOT", "NC", "POS", "UPI", "VIP"]);

/** Formats an internal option or status without changing its underlying value. */
export function formatUiLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/[A-Za-z]+/g, (word) => {
    return ACRONYMS.has(word) ? word : word[0].toUpperCase() + word.slice(1).toLowerCase();
  });
}
