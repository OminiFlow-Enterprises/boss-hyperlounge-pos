const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);

async function captureSlip(win, sharpBill) {
  const zoom = sharpBill ? 2 : 1;
  win.setContentSize(320 * zoom, 800);
  win.webContents.setZoomFactor(zoom);
  const rect = await win.webContents.executeJavaScript(`document.fonts.ready.then(() => {
    const slip = document.querySelector(".slip") || document.body;
    const bounds = slip.getBoundingClientRect();
    return {
      x: Math.floor(bounds.left),
      y: Math.floor(bounds.top),
      width: Math.ceil(bounds.right) - Math.floor(bounds.left),
      height: Math.ceil(Math.max(bounds.height, slip.scrollHeight))
    };
  })`);
  if (!rect.width || !rect.height) throw new Error("The slip layout was empty");

  // Keep the same layout width while making the whole slip visible for capture.
  win.setContentSize(320 * zoom, (rect.y + rect.height + 1) * zoom);
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const image = await win.webContents.capturePage({
    x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom,
  });
  if (image.isEmpty()) throw new Error("The slip image was empty");
  return { image, rect };
}

async function printOfficeSlip(win, printer, { sharpBill = false, rejectBlank = false, preferredQueue = "" } = {}) {
  const { image, rect } = await captureSlip(win, sharpBill);
  if (rejectBlank) {
    const pixels = image.toBitmap();
    let hasInk = false;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] > 128 && pixels[offset] < 220 &&
          pixels[offset + 1] < 220 && pixels[offset + 2] < 220) {
        hasInk = true;
        break;
      }
    }
    if (!hasInk) throw new Error("The KOT rendered blank. Check the printer status before reprinting.");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-office-slip-"));
  const imagePath = path.join(dir, "slip.png");
  try {
    fs.writeFileSync(imagePath, image.toPNG());
    const script = fs.readFileSync(path.join(__dirname, "print-office-slip.ps1"), "utf8");
    await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], {
      timeout: 25_000,
      windowsHide: true,
      env: {
        ...process.env,
        POS_SLIP_IMAGE: imagePath,
        POS_SLIP_QUEUE: printer,
        POS_SLIP_PREFERRED_QUEUE: preferredQueue,
        POS_SLIP_WIDTH_PX: String(rect.width),
        POS_SLIP_HEIGHT_PX: String(rect.height),
        POS_SLIP_SHARP_BILL: sharpBill ? "1" : "0",
      },
    });
  } finally {
    fs.rmSync(imagePath, { force: true });
    fs.rmdirSync(dir);
  }
}

module.exports = { printOfficeSlip, captureSlip };
