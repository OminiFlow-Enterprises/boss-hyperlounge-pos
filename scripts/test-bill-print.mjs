import net from "node:net";

const { formatTestBillEscPos } = await import("../src/server/hardware/escpos.ts");

const data = formatTestBillEscPos();
const host = "192.168.1.56";
const port = 9100;

await new Promise((resolve, reject) => {
  const s = net.connect(port, host, () => {
    s.write(data, (err) => {
      if (err) reject(err);
      else s.end(() => resolve());
    });
  });
  s.setTimeout(8000);
  s.on("timeout", () => reject(new Error(`timeout ${host}:${port}`)));
  s.on("error", reject);
});

console.log(`OK sent ${data.length} bytes to bill ${host}:${port}`);
