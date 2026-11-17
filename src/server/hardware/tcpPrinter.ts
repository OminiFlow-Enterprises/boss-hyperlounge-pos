import net from "node:net";
import { formatKotEscPos, formatReceiptEscPos, formatTestEscPos } from "./escpos.js";
import type { IPrinter, KotPrintPayload, ReceiptPayload } from "./types.js";

export type TcpPrinterTarget = {
  /** Windows queue name, for logs only. */
  name: string;
  host: string;
  port?: number;
};

function sendRaw(host: string, port: number, data: Buffer, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish(new Error(`Printer timeout ${host}:${port}`)));
    socket.once("error", (err) => finish(err));
    socket.connect(port, host, () => {
      socket.write(data, (err) => {
        if (err) finish(err);
        else socket.end(() => finish());
      });
    });
  });
}

export class TcpEscPosPrinter implements IPrinter {
  readonly host: string;
  readonly port: number;

  constructor(public name: string, host: string, port = 9100) {
    this.host = host;
    this.port = port;
  }

  isConnected(): boolean {
    return Boolean(this.host);
  }

  private async send(data: Buffer) {
    try {
      await sendRaw(this.host, this.port, data);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async printReceipt(payload: ReceiptPayload) {
    return this.send(formatReceiptEscPos(payload));
  }

  async printKOT(payload: KotPrintPayload) {
    return this.send(formatKotEscPos(payload));
  }

  async testPrint() {
    return this.send(formatTestEscPos(this.name, this.host));
  }
}

/** Printers read from this Windows PC — do not invent. */
export const POS_PRINTERS = {
  bill: { name: "bill", host: "192.168.1.56", port: 9100 },
  kitchen: { name: "kitchen", host: "192.168.1.208", port: 9100 },
  bar: { name: "bar", host: "192.168.1.188", port: 9100 },
  cafeBar: { name: "cafe bar", host: "192.168.1.189", port: 9100 },
} as const;
