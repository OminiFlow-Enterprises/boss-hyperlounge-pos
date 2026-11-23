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
import { POS_PRINTERS, TcpEscPosPrinter } from "./tcpPrinter.js";

export type { ICardReader, IPrinter, ICashDrawer, ICustomerDisplay, IBarcodeScanner };
export type { CardReadResult, KotPrintPayload, ReceiptPayload };
export { POS_PRINTERS, TcpEscPosPrinter };

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
  cafeBar: IPrinter;
  office?: IPrinter;
  drawer: ICashDrawer;
  display: ICustomerDisplay;
}

export function createHardware(options?: { memory?: boolean }): HardwareBus {
  if (options?.memory || process.env.POS_MEMORY_PRINTERS === "1") {
    return {
      rfid: new MemoryCardReader(),
      nfc: new MemoryCardReader(),
      barcode: new MemoryBarcodeScanner(),
      receipt: new MemoryPrinter("RECEIPT"),
      kitchen: new MemoryPrinter("KITCHEN"),
      bar: new MemoryPrinter("BAR"),
      cafeBar: new MemoryPrinter("CAFE BAR"),
      office: new MemoryPrinter("OFFICE"),
      drawer: new MemoryCashDrawer(),
      display: new MemoryCustomerDisplay(),
    };
  }
  const printer = ({ name, host, port }: (typeof POS_PRINTERS)[keyof typeof POS_PRINTERS]) =>
    new TcpEscPosPrinter(name, host, port);
  const officeQueue = process.env.POS_OFFICE_PRINTER_QUEUE?.trim();
  return {
    rfid: new MemoryCardReader(),
    nfc: new MemoryCardReader(),
    barcode: new MemoryBarcodeScanner(),
    receipt: printer(POS_PRINTERS.bill),
    kitchen: printer(POS_PRINTERS.kitchen),
    bar: printer(POS_PRINTERS.bar),
    cafeBar: printer(POS_PRINTERS.cafeBar),
    office: officeQueue ? new TcpEscPosPrinter(officeQueue, "localhost") : undefined,
    drawer: new MemoryCashDrawer(),
    display: new MemoryCustomerDisplay(),
  };
}
