import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api.js";
import { trackKotPrintJobs, watchKotPrintJobs } from "../src/client/kotPrintJobs.js";
import { printBillHtml } from "../src/client/printBillHtml.js";

vi.mock("../src/client/api.js", () => ({ api: { post: vi.fn() }, ApiError: Error }));
vi.mock("../src/client/printBillHtml.js", () => ({ printBillHtml: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it("prints both connected KOT slips in order without waiting for a polling interval", async () => {
  vi.stubGlobal("window", {
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
  });
  const status = new Map([
    ["restaurant", "QUEUED"],
    ["club", "QUEUED"],
  ]);
  vi.mocked(api.post).mockImplementation(async (url, body) => {
    const id = url.split("/").at(-1)!;
    const action = (body as { action?: string } | undefined)?.action;
    if (action === "claim" && status.get(id) === "QUEUED") {
      status.set(id, "PRINTING");
      return { status: "PRINTING", html: id };
    }
    if (action === "finish") status.set(id, "PRINTED");
    return { destination: "CONNECTED", status: status.get(id) };
  });

  let finishFirst!: (result: { ok: boolean }) => void;
  const firstSlip = new Promise<{ ok: boolean }>((resolve) => { finishFirst = resolve; });
  vi.mocked(printBillHtml).mockReturnValueOnce(firstSlip).mockResolvedValueOnce({ ok: true });
  const stop = watchKotPrintJobs(vi.fn());
  try {
    trackKotPrintJobs(["restaurant", "club"]);
    await vi.waitFor(() => expect(vi.mocked(printBillHtml).mock.calls).toEqual([["restaurant", ""]]));
    expect(status.get("club")).toBe("QUEUED");
    finishFirst({ ok: true });
    await vi.waitFor(() => expect(status.get("club")).toBe("PRINTED"));
    expect(vi.mocked(printBillHtml).mock.calls).toEqual([["restaurant", ""], ["club", ""]]);
  } finally {
    stop();
  }
});
