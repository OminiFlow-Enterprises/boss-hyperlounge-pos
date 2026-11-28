declare global {
  interface Window {
    bossPrint?: {
      printHtml: (html: string, deviceName?: string) => Promise<{ ok: boolean; error?: string }>;
      exportPdf?: (opts?: { landscape?: boolean }) => Promise<Uint8Array | { data?: number[] }>;
      printItemWiseSales?: () => Promise<{ ok: boolean; error?: string }>;
    };
    bossWindow?: {
      minimize: () => Promise<{ ok: boolean }>;
      maximize: () => Promise<{ ok: boolean }>;
      close: () => Promise<{ ok: boolean }>;
    };
  }
}

export type BillPrintApiResult = {
  ok?: boolean;
  mode?: string;
  html?: string;
  printed?: boolean;
  error?: string;
};

/**
 * After `/api/invoices/:id/print`:
 * - Server already silent-prints HTML to Windows `bill` when `printed: true`.
 * - If the server could not print, fall back to Electron IPC / iframe.
 */
export async function handleBillPrintResponse(
  result: BillPrintApiResult | null | undefined,
  deviceName = "bill",
): Promise<{ ok: boolean; error?: string }> {
  if (!result) return { ok: false, error: "No print response" };
  if (result.printed) return { ok: true };
  if (result.mode === "html" && result.html) return printBillHtml(result.html, deviceName);
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error || "Print failed" };
}

/** Print an HTML bill slip — Electron silent to `bill`, else iframe + window.print. */
export async function printBillHtml(html: string, deviceName = "bill"): Promise<{ ok: boolean; error?: string }> {
  if (window.bossPrint?.printHtml) {
    return window.bossPrint.printHtml(html, deviceName);
  }

  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc) {
      frame.remove();
      resolve({ ok: false, error: "Could not open print frame" });
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();
    const done = (ok: boolean, error?: string) => {
      setTimeout(() => frame.remove(), 800);
      resolve({ ok, error });
    };
    const trigger = () => {
      try {
        win.focus();
        win.print();
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    };
    if (doc.readyState === "complete") setTimeout(trigger, 50);
    else frame.onload = () => setTimeout(trigger, 50);
  });
}
