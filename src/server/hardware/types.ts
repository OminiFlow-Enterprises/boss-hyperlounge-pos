export interface CardReadResult {
  cardNumber?: string;
  cardUid?: string;
  source: "RFID" | "NFC" | "BARCODE" | "QR" | "MANUAL";
}

export interface ICardReader {
  readCard(): Promise<CardReadResult | null>;
  getCardUID(): Promise<string | null>;
  isConnected(): boolean;
}

/** Simple slip (card recharge, etc.). */
export interface SimpleReceiptPayload {
  kind?: "simple";
  title: string;
  lines: string[];
  footer?: string;
}

/** Venue block for bill header — always from settings / caller, never sample products. */
export interface BillVenueInfo {
  name: string;
  unit: string;
  address1: string;
  address2: string;
  address3: string;
  contact: string;
  gstin: string;
  hsn: string;
  tin: string;
  footer?: string;
}

/** Native THE BOSS slip defaults (overridable via settings). */
export const BILL_VENUE_DEFAULTS: BillVenueInfo = {
  name: "THE BOSS",
  unit: "(A UNIT OF BROTZEIT95)",
  address1: "THE GRAND WALK,",
  address2: "LAXMI MANDIR TIRAHA, TONK ROAD",
  address3: "JAIPUR - 302015",
  contact: "Contact No.:+91-7900890041",
  gstin: "08ABFFB3127P1Z7",
  hsn: "996331",
  tin: "08694753852",
  footer: "~~** Thanks for coming--Visit Again**~",
};

/** Restaurant / bar bill — match THE BOSS sample slip. Money fields are paise. */
export interface BillReceiptPayload {
  kind: "bill";
  venue: BillVenueInfo;
  outlet: string;
  billNo: string;
  tableNo: string;
  waiter?: string;
  guestName?: string;
  guestGstin?: string;
  remark?: string;
  pax?: string;
  createdAt: string;
  items: Array<{ name: string; rate: number; qty: number; amount: number }>;
  subtotal: number;
  discount: number;
  discountPct: number;
  tax: number;
  serviceCharge: number;
  serviceChargePct: number;
  otherCharges: number;
  roundOff: number;
  netTotal: number;
  /**
   * Tax / discount rows under Total. Optional `base` is the middle column
   * (taxable amount) on the native slip, e.g. Vat 20% | 13623.80 | 2724.76
   */
  totalLines?: Array<{ label: string; base?: number | string; amount: number }>;
}

export type ReceiptPayload = SimpleReceiptPayload | BillReceiptPayload;

export interface KotPrintPayload {
  kotNumber: string;
  tableCode: string;
  waiter?: string;
  station: "KITCHEN" | "BAR" | "CAFE BAR" | "BILL" | "OFFICE" | "CONNECTED" | "OFFICE LOCAL";
  operatorName?: string;
  reprint: boolean;
  customerCopy?: boolean;
  tableTransfer?: { outlet: string; fromTable: string; toTable: string };
  /**
   * First KOT on a table/session → NEW ORDER.
   * Table already running (later KOTs / cancel) → RUNNING ORDER.
   */
  orderBanner?: "NEW ORDER" | "RUNNING ORDER";
  /** Printed under the item table (same place as sample “TEST ITEM TWO”). */
  remark?: string | null;
  items: Array<{ qty: number; name: string; notes?: string | null; rate?: number; price?: number }>;
  createdAt: string;
}

export interface IPrinter {
  name: string;
  isConnected(): boolean;
  printReceipt(payload: ReceiptPayload): Promise<{ ok: boolean; error?: string }>;
  printKOT(payload: KotPrintPayload): Promise<{ ok: boolean; error?: string }>;
  testPrint(): Promise<{ ok: boolean; error?: string }>;
}

export interface ICashDrawer {
  isConnected(): boolean;
  open(): Promise<{ ok: boolean; error?: string }>;
}

export interface ICustomerDisplay {
  isConnected(): boolean;
  show(text: string, amount?: number): Promise<void>;
  clear(): Promise<void>;
}

export interface IBarcodeScanner {
  isConnected(): boolean;
  read(): Promise<string | null>;
}
