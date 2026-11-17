# Session handoff

Saved so the same Cursor account can continue on the Windows master PC. The keyboard and Windows-native rules in this folder still apply.

## What this is

THE BOSS / RID Infotech club and restaurant POS. React + Vite UI, Express API, SQLite (`better-sqlite3`). Desktop shell is Electron 36.9.5, not a website and not a browser kiosk.

Departments: Alt+1 THE BOSS CLUB, Alt+2 RESTAURANT, Alt+3 NC, Alt+4 BAR. Default outlet is BAR. Money is integer paise.

## Run

- Dev: `npm run dev` — UI on `[::1]:5173`, API on `127.0.0.1:8787`.
- One process: `npm start` serves `dist/client` when `NODE_ENV=production`.
- Windows app already built: `release/THE BOSS POS-1.0.0-win.zip`. Unzip and run `THE BOSS POS.exe`. No Node install on that PC. `npm run dist:win` rebuilds it.
- Electron main: `electron/main.cjs`. It removes the menu and forwards F1 and F3–F12 plus Alt+1–4 so Windows does not refresh, fullscreen, or open DevTools. Alt+F4 still closes the window.
- `data/hyperlounge.sqlite` is the live database (gitignored, about 99MB). The Windows zip copies it into the app. First launch on a PC copies it to that PC’s user data folder.

## Data already imported

From the SQL Server backup of `theboss_2025`, into the SQLite file:

- Active items with price, sales group, and item group.
- Users. Login keeps the original username. PIN for imported staff is **1234**. SUNIL is inactive.
- Orders, KOT lines, bills, and settlement payments. Link payments by bill number. A settlement’s department often does not match the order outlet.
- Card recharges from `tr_RestaurantBooking`. One current balance per card, dated now, so the 6 AM overnight expiry does not wipe history. Full recharge history is in `bookings`.

Do not import sync logs, print copies, audit, hotel, spa, laundry, or purchase orders unless asked. Still not imported, and previously recommended: the 12 active bank accounts for the settlement dropdown, and the 33 complimentary names for F1.

## Billing behavior already done

- F3 Item Master: add, edit, delete.
- Item lookup is a Windows combobox filtered by the department tab. Empty item group still shows. A disabled department rate rejects the item.
- Sales-group tax is added on the KOT price and on settlement. A sales group whose name contains FREE is 0% even if the linked tax master says 24%.
- F10 Prepare Bill, then Discount, then Print Bill. Printed tables show Settlement (green).
- F11 Settlement: CASH, BANK TRANSFER, PREPAID CARD. Split until balance is 0. CASH has no account field. BANK TRANSFER asks for the bank name. PREPAID CARD asks for Card No and shows Insufficient amount when the card is short.
- F12 is the Restaurant Settlement Report for the current outlet, not the GST report. GST stays on the Report menu. One row per payment. Enter or double-click opens Restaurant Settlement for that row (Print, Update F2, Delete F4, Exit). Escape closes that dialog and does not close the report.
- Prepaid card settlements cannot be edited or deleted from that update window.
- Table list no longer sums every historical order. Running total runs only for an open session. Bootstrap should return in well under a second.

## Next job

The user has a LAN. Any other PC should use the master PC. They also want a mini printer connected.

Do this on the Windows master PC, after Cursor is open there:

1. Read the real IPv4 LAN address. Do not guess it.
2. Read the installed printer name, and the printer IP if it is a network mini printer. Do not guess it.
3. Master PC runs the POS and keeps the one database. Other PCs open `http://<master-ip>:8787`. They do not get their own database and they do not need Cursor.
4. Bills and KOTs print on the mini printer from the master. A 58mm printer is 32 characters wide. ESC/POS over port 9100 for a network printer, or the Windows printer queue for USB.
5. The server already listens on `0.0.0.0`. Windows Firewall may still block other PCs until port 8787 is allowed.

Printers are locked for testing in `.cursor/rules/printers.mdc`. Bill test printer: `bill` → `192.168.1.56:9100` (EPSON TM-T82). Kitchen `192.168.1.208`, bar `192.168.1.188`. ESC/POS KOT layout matches the real slip (`src/server/hardware/escpos.ts`). Do not change printers until the user asks.
