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

export interface ReceiptPayload {
  title: string;
  lines: string[];
  footer?: string;
}

export interface KotPrintPayload {
  kotNumber: string;
  tableCode: string;
  waiter?: string;
  station: "KITCHEN" | "BAR";
  reprint: boolean;
  items: Array<{ qty: number; name: string; notes?: string | null }>;
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
