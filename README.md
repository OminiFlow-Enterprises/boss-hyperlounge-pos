# BOSS Hyperlounge POS

BOSS Hyperlounge POS is an offline Windows Electron desktop app for lounge orders, billing, member cards, and shift reconciliation. One PC runs Electron and hosts the POS server and SQLite database. Other PCs on the same local network connect to that server through a browser. Billing works without an internet connection while the server PC and local network are available.

## Set up one server PC and multiple client PCs

1. Connect the server PC and client PCs to the same trusted local network. Ethernet or Wi-Fi can work without internet service. Give the server a stable LAN address, for example through a DHCP reservation on the router.
2. On the server PC, install and open THE BOSS POS. For a source checkout, use `npm run desktop` after installing dependencies. Keep the Electron app open and the server PC awake during service. Closing the app stops its server.
3. On the server PC, run `ipconfig` and find the IPv4 address of the active Ethernet or Wi-Fi adapter. The app starts at port `8787` and tries the next available port if that port is in use. If needed, confirm the actual port in the Electron user data directory under `logs/pos-debug.log`.
4. On each client PC, open `http://<server-ip>:<port>/` in a browser, for example `http://192.168.1.50:8787/`. Sign in with the staff account for that station. If connections are blocked, allow the POS port through Windows Firewall for the private network and restrict access to the local subnet.
5. To verify the setup, disconnect the site from the internet while keeping the LAN active. Sign in on both PCs. On test data, open a table on one PC, reload the floor view on the other, and confirm both show the same table. Then test a KOT, a bill, and settlement with the intended printer setup.

The current Electron launcher always starts its own local server and opens that server. Use Electron on the designated server and a browser on the other PCs. Starting Electron independently on each PC creates separate local databases. Clients need a working connection to the server for orders and payments. The LAN uses HTTP, so keep the POS on a trusted private network and avoid forwarding its port to the internet.

## Functional guide

| Area | What staff can do |
| --- | --- |
| Staff and access | Sign in with a username and PIN. Roles and assigned rights control access to operations such as settings, refunds, and cancellations. User Master manages staff accounts and rights. |
| Customers and member cards | Register customers, issue internal prepaid cards, recharge, check balances and ledger history, swap or block cards, and apply configured bonus rules. Paid and bonus balances are tracked separately. Member cards do not store bank-card credentials. |
| Floor and tables | Open a table, check in a guest or attach a member card, request a bill, transfer items or tables, and split or merge tables. |
| Orders and KOTs | Add items and notes, send kitchen order tickets (KOTs) to kitchen or bar, add another round, and look up, reprint, or void tickets subject to permissions. |
| Billing and settlement | Preview and generate invoices, apply permitted discounts, settle bills, and print or reprint receipts. The app records payments, supports member-card settlement and complimentary accounts, and provides refund and cancellation workflows. |
| Masters and inventory | Maintain items, item groups, department prices, tax settings, staff, and complimentary accounts. Inventory services record stock movements, purchases, and expenses. |
| Reports and day close | Review sales, GST, item totals, KOTs, bills, table and item transfers, payment and card settlements, reconciliation, and audit history. Record day close from reporting. |

A typical shift runs from opening a table and sending KOTs through bill generation, settlement, receipt printing, and reconciliation. A member-card sale adds customer/card check-in and uses the same server ledger for balance and payment.

To correct a payment mode, click the payment in the Settlement Report. Enter the amount and mode for the first part and press **Update (F2)**. The settlement screen fills in the remaining amount. Enter each next part and press **Post (F2)**. The report saves all parts together on the original settlement date once the remaining amount reaches zero. For example, a ₹1,000 cash entry can become ₹200 bank transfer and ₹800 cash. Choose **Discard** to abandon an unfinished split.

## Development and Windows builds

Use Node.js 22 and npm. A fresh dependency install or Windows packaging may require internet access. The installed POS runs locally.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked dependencies. |
| `npm run dev` | Start the Express API on port 8787 and Vite on port 5173 by default. Open `http://localhost:5173/`. |
| `npm test` | Run the Vitest suite. |
| `npm run build` | Compile the server, copy the schema, and build the React client into `dist/`. |
| `npm run desktop` | Build and open Electron for a local runtime test. |
| `npm run dist:win` | Build the Windows x64 NSIS installer into `release/`. |
| `npm start` | Start Express with the built UI after running `npm run build`. This mode runs outside Electron. |

Electron is pinned to 36.9.5 in `package.json`. The backend uses the native `better-sqlite3` module. If startup reports a `NODE_MODULE_VERSION` mismatch, rebuild the dependency for the runtime you are launching. From the repo root, the Electron rebuild command is `npm rebuild better-sqlite3 --runtime=electron --target=36.9.5 --dist-url=https://electronjs.org/headers`. Use `npm rebuild better-sqlite3` with Node 22 when switching back to Node-based tests or development if the installed binary targets Electron.

Use a disposable database for testing. For example, in PowerShell run `$env:POS_DATA_DIR = Join-Path $PWD 'data-test'` before `npm run dev` or `npm start`. The Electron launcher supplies its own data path, so this example applies to the Node launch modes. Freshly seeded demo users are defined in [seed.ts](src/server/db/seed.ts). Use venue accounts for live service.

## Technical reference

The Electron main process starts the Express backend under Electron's Node runtime, waits for the API, then loads the built React UI from loopback. Express listens on all interfaces and serves both the UI and `/api` in production. The browser clients send requests to the same host that served their UI. All clients share the server's records through the API.

| Task | Start reading here |
| --- | --- |
| Desktop startup, port selection, shortcuts, print IPC, and PDF | [electron/main.cjs](electron/main.cjs), [electron/preload.cjs](electron/preload.cjs) |
| Screens, keyboard flows, and API calls | [App.tsx](src/client/App.tsx), [api.ts](src/client/api.ts), [BillDialogs.tsx](src/client/BillDialogs.tsx), [Reports.tsx](src/client/Reports.tsx) |
| API routes, login, and request context | [server entry](src/server/index.ts), [Express app](src/server/api/app.ts), [permissions](src/shared/permissions.ts), [user rights](src/shared/userRights.ts) |
| Floor, orders, and KOTs | [tableService.ts](src/server/services/tableService.ts), [orderService.ts](src/server/services/orderService.ts) |
| Billing, rates, and currency | [billingService.ts](src/server/services/billingService.ts), [pricingService.ts](src/server/services/pricingService.ts), [money.ts](src/shared/money.ts) |
| Cards and reports | [cardService.ts](src/server/services/cardService.ts), [reportService.ts](src/server/services/reportService.ts) |
| Schema, startup migrations, and seed records | [schema.sql](src/server/db/schema.sql), [database.ts](src/server/db/database.ts), [seed.ts](src/server/db/seed.ts) |
| Printer routing and receipt layouts | [hardware adapters](src/server/hardware/index.ts), [TCP printer config](src/server/hardware/tcpPrinter.ts), [bill HTML](src/server/hardware/billReceiptHtml.ts), [KOT HTML](src/server/hardware/kotReceiptHtml.ts) |
| Windows packaging and regression tests | [dist-win.mjs](scripts/dist-win.mjs), [acceptance workflow](tests/acceptance.test.ts), [test suite](tests/) |

### Data and backups

- The server is the source of truth for tables, orders, KOTs, invoices, payments, staff, and card balances. Billing uses integer paise and calculates totals server-side. Card operations record ledger entries with paid and bonus balances tracked separately.
- Source Electron uses `data/hyperlounge.sqlite` in the checkout. Installed Electron uses `<Electron userData>/data/hyperlounge.sqlite`. On first launch it copies the bundled database into that location if the destination is absent. The Windows installer bundles the checkout's database, so verify that the packaged data is appropriate before distributing it.
- SQLite uses write-ahead logging. For a simple file backup, close the POS server cleanly before copying the database. Keep the backup off the server PC and reopen the POS after copying. Each client accesses data through the API, so there is no need to share the database file over the network.
- The sync queue currently uses an in-memory sink by default. It is useful for exercising the sync workflow in tests. Live deployment and backups depend on the server database.

### Printing

The backend uses local-network ESC/POS printers. The current hardware adapter routes receipt, kitchen, and bar printing to the configured bill printer. Check the active routing in [hardware/index.ts](src/server/hardware/index.ts) before changing printers. Electron also exposes desktop print and PDF operations through preload IPC. Test printing from the actual server and browser stations because their print capabilities differ. For backend testing without sending jobs to a real printer, set `POS_MEMORY_PRINTERS=1`.

## Working on the app with Codex

Start future requests with “Read README.md, then …” and describe which staff role and station are involved. For a bug report, include the floor/table or report affected, the steps to reproduce, and whether it occurs on the Electron server window, a browser client, or both.

For changes to billing, card balances, tables, or inventory, trace the request from the React screen through `src/client/api.ts`, the Express route, and the server service before editing. Check the relevant schema and tests so the change works with existing data. Keep the one-server LAN workflow working without internet access.
