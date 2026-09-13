# BOSS Hyperlounge POS

Offline-first club/lounge POS for the full floor workflow:

**Customer → Member card → Recharge → Table → Order → KOT → Kitchen/Bar → Settlement → Bill → Day close**

Member cards are internal prepaid lounge cards. The system never stores bank debit/credit PAN, CVV, or track data.

## Stack

- Local SQLite (`better-sqlite3`) — all sales and card ledgers live on the terminal
- Express API on `http://127.0.0.1:8787`
- React POS UI (Vite) on `http://127.0.0.1:5173`
- Hardware ports for RFID/NFC, barcode, receipt/kitchen/bar printers, cash drawer, and customer display
- Sync queue with idempotency keys for cloud catch-up after an outage

## Run

```bash
npm install
npm test
npm run dev
```

Production (one process serves the UI and API):

```bash
npm run build
npm start
```

Repo: https://github.com/OminiFlow-Enterprises/boss-hyperlounge-pos

## Deploy

One-click on Render: [Deploy to Render](https://render.com/deploy?repo=https://github.com/OminiFlow-Enterprises/boss-hyperlounge-pos)

`render.yaml` builds and starts the POS. Docker:

```bash
docker build -t boss-hyperlounge-pos .
docker run -p 8787:8787 boss-hyperlounge-pos
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

Demo PINs (username / PIN):

| User | PIN | Role |
| --- | --- | --- |
| owner | 0000 | Owner reports, settings |
| manager | 1111 | Swap, block, refund, void |
| cashier | 2222 | Recharge, settlement |
| waiter | 3333 | Tables, order, KOT, bill request |
| kitchen | 4444 | Kitchen KDS |
| bar | 5555 | Bar KDS |

Waiters cannot change prices, issue large discounts, cancel paid invoices, refund, or edit stock.

## Card ledger

Balances are not typed into the database from the UI. Every recharge, purchase, bonus, refund, swap, and adjustment writes an immutable `card_ledger` row. Cached `paid_balance` / `bonus_balance` on the card are always reconciled from that ledger.

Paid and bonus balances are tracked separately. Bonus rules (minimum recharge, flat/percent, cap, expiry) are configurable.

## Acceptance path

`tests/acceptance.test.ts` issues a Regular card, recharges ₹5,000, seats table 12, sends kitchen + bar KOTs, adds a second round, pays ₹4,200 on the member card, leaves ₹800, closes the table, reduces inventory, retains KOT history, updates sales, and flushes the offline sync queue without duplicates.
