import type {
  IBarcodeScanner,
  ICardReader,
  ICashDrawer,
  ICustomerDisplay,
  IPrinter,
  CardReadResult,
  KotPrintPayload,
  ReceiptPayload,
} from "./types.js";

export type { ICardReader, IPrinter, ICashDrawer, ICustomerDisplay, IBarcodeScanner };
export type { CardReadResult, KotPrintPayload, ReceiptPayload };

interface PrintLog {
  device: string;
  kind: "receipt" | "kot" | "test";
  payload: unknown;
  at: string;
  reprint?: boolean;
}

export class MemoryCardReader implements ICardReader {
  connected = true;
  nextRead: CardReadResult | null = null;

  async readCard(): Promise<CardReadResult | null> {
    return this.nextRead;
  }

  async getCardUID(): Promise<string | null> {
    return this.nextRead?.cardUid ?? null;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export class MemoryPrinter implements IPrinter {
  connected = true;
  failNext = false;
  logs: PrintLog[] = [];

  constructor(public name: string) {}

  isConnected(): boolean {
    return this.connected;
  }

  private result(kind: PrintLog["kind"], payload: unknown, reprint?: boolean) {
    if (this.failNext) {
      this.failNext = false;
      return { ok: false as const, error: `${this.name} offline` };
    }
    this.logs.push({ device: this.name, kind, payload, at: new Date().toISOString(), reprint });
    return { ok: true as const };
  }

  async printReceipt(payload: ReceiptPayload) {
    return this.result("receipt", payload);
  }

  async printKOT(payload: KotPrintPayload) {
    return this.result("kot", payload, payload.reprint);
  }

  async testPrint() {
    return this.result("test", { message: `TEST PRINT ${this.name}` });
  }
}

export class MemoryCashDrawer implements ICashDrawer {
  connected = true;
  opened = 0;

  isConnected(): boolean {
    return this.connected;
  }

  async open() {
    if (!this.connected) return { ok: false as const, error: "Cash drawer disconnected" };
    this.opened += 1;
    return { ok: true as const };
  }
}

export class MemoryCustomerDisplay implements ICustomerDisplay {
  connected = true;
  lastText = "";
  lastAmount?: number;

  isConnected(): boolean {
    return this.connected;
  }

  async show(text: string, amount?: number) {
    this.lastText = text;
    this.lastAmount = amount;
  }

  async clear() {
    this.lastText = "";
    this.lastAmount = undefined;
  }
}

export class MemoryBarcodeScanner implements IBarcodeScanner {
  connected = true;
  nextCode: string | null = null;

  isConnected(): boolean {
    return this.connected;
  }

  async read() {
    return this.nextCode;
  }
}

export interface HardwareBus {
  rfid: ICardReader;
  nfc: ICardReader;
  barcode: IBarcodeScanner;
  receipt: IPrinter;
  kitchen: IPrinter;
  bar: IPrinter;
  drawer: ICashDrawer;
  display: ICustomerDisplay;
}

export function createHardware(): HardwareBus {
  return {
    rfid: new MemoryCardReader(),
    nfc: new MemoryCardReader(),
    barcode: new MemoryBarcodeScanner(),
    receipt: new MemoryPrinter("RECEIPT"),
    kitchen: new MemoryPrinter("KITCHEN"),
    bar: new MemoryPrinter("BAR"),
    drawer: new MemoryCashDrawer(),
    display: new MemoryCustomerDisplay(),
  };
}

export function printerForStation(hw: HardwareBus, station: "KITCHEN" | "BAR"): IPrinter {
  return station === "BAR" ? hw.bar : hw.kitchen;
}
