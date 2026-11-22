# Five-PC POS load test

Use this Windows PC as the only server. The target is five simultaneous operators. If this PC is one of the five, use four remote PCs and a browser on the server. If all five are remote, use five client PCs and leave the server dedicated. Current server LAN address is `192.168.1.57`. Confirm it with `ipconfig` before the run.

## Start the test server

From the repository root, run the following in a dedicated PowerShell window. This starts the checked-out application on TCP port 8797, with a fresh seeded database and in-memory printer adapters. If testing a newer checkout, build it before starting. This checkout's installed SQLite native module targets Electron's runtime.

```powershell
$env:POS_DATA_DIR = Join-Path $PWD ('.cache\pos-load-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$env:PORT = '8797'
$env:NODE_ENV = 'production'
$env:POS_MEMORY_PRINTERS = '1'
$env:ELECTRON_RUN_AS_NODE = '1'
$posTestRuntime = Resolve-Path '.\node_modules\electron\dist\electron.exe'
$posTestServer = Start-Process -FilePath $posTestRuntime -ArgumentList 'dist/server/index.js' -WindowStyle Hidden -PassThru
```

Open `http://127.0.0.1:8797` on the server and `http://192.168.1.57:8797` in Edge or Chrome on the other PCs. If a client cannot connect, confirm the server works locally, run `Test-NetConnection 192.168.1.57 -Port 8797` on the client and check the Windows Firewall. If needed, allow TCP 8797 on the server's Private profile for the local subnet for the duration of testing. Use a trusted LAN and browser clients. Keep the live address and the test address distinct in bookmarks.

Use test staff accounts, test tables and test payments. Start with seeded data. If realistic report volume is needed, restore an approved, sanitized snapshot into a new test directory as `hyperlounge.sqlite` before startup. Preserve the verified backup files.

**Zero physical prints.** Confirm `POS_MEMORY_PRINTERS=1` before launch. Send KOTs through the normal order workflow and verify their records in the app. Generate and save bills, then settle them. Skip Print, Reprint, Test Print, browser print shortcuts and any Save-and-Print action. Cancel any unexpected print dialog. Compare Windows print queue job counts before and after the run where queues are available. Any physical print or new test print job fails the run.

## Workload

| Phase | Duration | What to do |
| --- | ---: | --- |
| Baseline | 10 min | One user completes 5 table-to-settlement cycles. Other stations verify sign-in and shared table visibility. |
| Normal load | 20 min | Three order stations each complete 10 order/KOT cycles across assigned tables. The cashier generates and settles the resulting 30 bills. The fifth station checks table visibility, runs sales and settlement reports every minute, and tests balance lookup if member cards are used. |
| Peak | 10 min | Finish open baseline work first. All five users start together, each on a separate table, and complete 3 table-to-settlement cycles. Make one coordinated KOT send and one coordinated settlement across the five stations. |
| Shared data | 10 min | On a dedicated test table, two users add different items at the same time, then reload both views and check the resulting quantities. Two authorized users attempt to settle the same outstanding invoice. Verify one payment and the correct remaining balance. |
| Recovery | 10 min | Disconnect one client during an order workflow. Reconnect and check the table, KOT and payment state before retrying anything. If practical, leave all clients on the LAN and remove internet access to confirm normal local operation. |

## Record and decide

- Record station, operator role, phase, action, elapsed time, table/KOT/invoice reference and result. Use browser Developer Tools Network timings or time the visible UI response consistently on all stations. Track server CPU, memory and disk in Task Manager once a minute and during bursts.
- Proposed pass thresholds are p95 at or below 2 seconds for table, order, KOT and settlement actions and 5 seconds for reports. Report sample counts and calculate p95 by action from pooled station timings. Flag any timeout, unexpected API error or SQLite lock error.
- Reconcile orders with KOTs, bills and payment records. Compare the run's payment totals against the settlement report and confirm that each settled bill appears exactly once. Require zero lost orders, duplicate payments, unexplained balances or physical prints. Record checkout revision, dataset, client count and any failures before repeating a failed phase.
- To end the test, close the test browsers and run `Stop-Process -Id $posTestServer.Id` in the same PowerShell session. Remove any temporary firewall rule created for port 8797. Preserve run results in a secure location if they contain POS data.

## Backup and restore

The installed app and checkout snapshots dated 22 November 2026 are in the repository's ignored `data` directory. Use the installed snapshot for the installed app, and the checkout snapshot for the source app. Both were created with SQLite's online backup API and passed `PRAGMA integrity_check`. Keep a secure copy off this PC. For a restore rehearsal, make a separate copy named `hyperlounge.sqlite` in a new directory and point the test server to it. A live restore requires stopping the server and preserving its current database and WAL sidecars together before putting the verified snapshot in place.
