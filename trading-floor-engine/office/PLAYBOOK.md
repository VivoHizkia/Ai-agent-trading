# Playbook — Strategi Trading Floor

> Sumber kebenaran: [`src/strategies/index.ts`](../src/strategies/index.ts). Ini daftar
> **lengkap** strategi yang dikenal sistem — tidak ada strategi lain yang bisa dieksekusi.
> Setup yang tidak cocok dengan salah satu `strategyId` di bawah **tidak bisa masuk ke
> watchlist eksekusi** (`office/execution/watchlist.json`); paling jauh cuma bisa jadi
> catatan analisa/diskusi di inbox, bukan entry asli.

Tiap baris di `office/execution/watchlist.json` memasangkan satu simbol + timeframe + satu
`strategyId` berikut. Bot (`bot.ts`) mengevaluasi strategi itu bar demi bar; Risk Engine
([RISK-RULES.md](./RISK-RULES.md)) yang memutuskan apakah sinyalnya layak dieksekusi.

| `strategyId` | Nama | Logika singkat | Exit |
|---|---|---|---|
| `ema_trend` | EMA cross + filter EMA200 | Cross EMA cepat/lambat, difilter arah tren EMA200 | Target tetap |
| `donchian` | Donchian breakout + ATR trailing | Breakout dari channel Donchian N-bar | Trailing (ATR), tanpa target tetap |
| `ema_adx` | EMA cross + filter ADX | Cross EMA, difilter kekuatan tren ADX | Target tetap |
| `rsi_range` | RSI mean reversion (pasar range) | Entry di ekstrem RSI saat pasar sedang sideways | Target tetap |
| `trend_long` | Long-only tren + ATR trailing | Entry searah tren kuat, long-only | Trailing (ATR), tanpa target tetap |

## Untuk Analis Teknikal (Tio)

Tugasmu adalah membaca hasil scan (`office/backtests/scan-*.json`, dibuat lewat
`npm run scan:top100`) dan hasil debat (`office/debates/debate-*.json`, dari `npm run debate`),
lalu menjelaskan temuannya dengan bahasa manusia ke Raka lewat inbox — **bukan** menciptakan
setup baru di luar 5 strategi di atas. Kalau kamu melihat pola menarik yang tidak tertangkap
strategi manapun (mis. divergensi RSI manual, pola candlestick spesifik), tulis itu sebagai
catatan observasi di `CATATAN-TIO.md` dan tandai jelas **"di luar playbook — belum bisa
dieksekusi otomatis"**, supaya tidak disalahartikan sebagai sinyal siap approval.

## Untuk Analis Sentimen (Sendi)

Sumber data: funding rate + open interest (`src/data/binance.ts`), kalender event
(`src/data/coinmarketcal.ts`, opsional). Tugasmu memberi konteks ("funding tinggi + OI naik =
crowd long, waspada") dan flag "jangan entry menjelang berita high-impact" ke Raka — ini input
kualitatif, bukan sinyal entry. Risk Engine tidak membaca sentimen; dampaknya cuma lewat
rekomendasi manusiawi yang kamu kirim.
