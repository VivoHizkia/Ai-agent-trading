# Trading Floor

Bot futures crypto rule-based (Binance USDT-M) dengan "kantor virtual" sebagai dashboard.

| Folder | Isi |
|---|---|
| `trading-floor-engine/` | Strategi, backtest walk-forward, Risk Engine, bot eksekusi, notifier Telegram |
| `trading-floor-ui/` | Dashboard Next.js (kantor isometrik) yang membaca `trading-floor-engine/office/` |

Keputusan entry murni dari strategi + Risk Engine yang sudah diuji walk-forward; agent AI hanya menulis laporan dan tidak bisa menimpa keputusan itu. Detail lengkap ada di [CLAUDE.md](CLAUDE.md).

## Menjalankan

```bash
cd trading-floor-engine
npm install
cp .env.example .env      # isi API key Binance (izin Futures saja, TANPA Withdraw) dan token Telegram
npm test
npm run bot               # EXEC_MODE=dry_run dulu; live hanya kalau EXEC_MODE=live
npm run notify

cd ../trading-floor-ui
npm install
cp .env.local.example .env.local
npm run dev               # http://localhost:3000
```

## Yang sengaja tidak ada di repo

- `.env` / `.env.local`: kredensial. Jangan pernah di-commit.
- `trading-floor-engine/data/`: cache harga Binance (diunduh ulang dengan `npm run fetch`).
- `trading-floor-engine/office/` selain dokumen aturan: data akun (saldo, trade, log, state bot).

**Peringatan:** dengan `EXEC_MODE=live`, bot mengirim order sungguhan memakai uang asli. Hasil backtest bukan jaminan hasil ke depan.
