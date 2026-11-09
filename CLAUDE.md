# Trading Floor — peta project (C:\Users\user\trading)

Bot futures crypto (Binance USDT-M) yang jalan **LIVE dengan uang asli**, ditambah "kantor virtual" isometrik sebagai dashboard.
Pemilik: Vivo. Bahasa komunikasi: Bahasa Indonesia.

## Folder

| Folder | Isi | Catatan |
|---|---|---|
| `trading-floor-engine/` | Engine TypeScript (tsx, ESM): strategi, backtest walk-forward, Risk Engine, bot eksekusi, agent AI, layanan kantor | Satu-satunya bagian yang mengirim order ke Binance |
| `trading-floor-ui/` | Dashboard Next.js 15 (kantor isometrik, canvas 2D) | Punya `CLAUDE.md` sendiri dengan aturan keamanan UI: **baca dan patuhi** |
| `trading-floor-engine/office/` | "Papan pengumuman" bersama: semua komunikasi engine → UI lewat file di sini | UI membaca dari sini via `OFFICE_DIR` |
| `dashboard/` | Project lama | Jangan disentuh |
| `ecosystem.config.cjs`, `PM2.md`, `trading-floor-start.bat` | Konfigurasi pm2 (opsional; pm2 belum ter-install global, saat ini semua jalan manual di terminal) | |

## Proses yang jalan (3 terminal)

| Perintah (di folder) | Fungsi |
|---|---|
| `npm run bot` (engine) | Bot eksekusi 24/7. Cek sinyal tiap bar 4h close (03/07/11/15/19/23 WIB) |
| `npm run notify` (engine) | Telegram + "layanan kantor": heartbeat bot, kalender berita (tiap jam), regime (30 mnt), data crowd (30 mnt), review mingguan (Minggu 21:00 WIB), Lab R&D (Minggu 08:00 WIB), scan discover + debat AI (Minggu ~10:00 WIB), laporan Head Trader AI (07:00 & 15:00 WIB), perintah Telegram |
| `npm run dev` atau `npm run build && npm start` (ui) | Dashboard di http://localhost:3000 |

Setelah mengubah kode engine, bot & notify harus di-restart. Setelah mengubah UI dengan `npm start`, harus `npm run build` ulang.

## JAWABAN JUJUR: apa yang benar-benar menentukan keputusan trading

Alur keputusan entry di `src/exec/bot.ts` (per koin di `office/execution/watchlist.json`, saat bar close):

1. **Strategi** (`src/strategies/`) memberi sinyal long/short + stop + target. Aturan kuant, bukan AI.
2. **Blokir berita** `activeBlackout()` (`src/ops/calendar.js`): menolak entry dekat berita high-impact USD. **Aktif: `NEWS_BLACKOUT_MINUTES=120`** (sinyal ≤120 menit sebelum/sesudah berita ditolak).
3. **Risk Engine** (`src/risk/engine.ts`): ukuran posisi dari risk %, batas leverage, batas rugi harian, jumlah posisi. Bisa menolak. Tidak ada agent/AI yang bisa menimpa.
4. **Filter crowd** `crowdContext()` (`src/ops/crowd.ts`): selalu mencatat funding/OI/long-short/Fear&Greed ke log & jurnal. **Hanya menolak entry kalau `CROWD_FILTER=true` (saat ini mati).**
5. **Approval manusia** di Ruang Bos: **dilewati karena `REQUIRE_APPROVAL=false`** → entry langsung otomatis.
6. Order MARKET + SL/TP dipasang di Binance (`src/exec/binance-trade.ts`).

Exit: SL/TP di exchange + logika exit strategi. Kill switch: file `office/execution/STOP` (bisa dibuat dari dashboard atau `npm run bot:stop`) → bot berhenti; SL/TP yang sudah terpasang tetap aktif di Binance.

### Status tiap bagian

| Bagian | Mempengaruhi order? | Keterangan |
|---|---|---|
| Strategi + Risk Engine | **YA** | Inti keputusan |
| Watchlist (`office/execution/watchlist.json`) | **YA** | Menentukan koin/strategi yang boleh ditradingkan. Diisi **manual**; tidak otomatis dari scan, debat, Lab, atau discover |
| Setelan strategi (`office/execution/params.json`, `src/ops/tuning.ts`) | **YA** | Tiap 90 hari notifier memilih ulang setelan tiap baris watchlist dari 365 hari data terakhir, dengan `selectParams` yang sama persis seperti walk-forward (hasil uji: +577R vs +455R dengan setelan default). Bot membaca tiap tick; posisi terbuka tetap memakai setelan saat entry (`BotPosition.params`). Urutan: default < params.json < `params` di baris watchlist. Manual: `npm run tune -- --force` |
| Kill switch (STOP) | **YA** | Menghentikan bot |
| Blokir berita | **YA, aktif** | `NEWS_BLACKOUT_MINUTES=120` (bot cek tiap 4 jam, jadi 30–60 menit hampir tidak pernah kena) |
| Filter crowd | Bisa, **saat ini mati** | Nyalakan dengan `CROWD_FILTER=true`; disarankan setelah data jurnal cukup |
| Approval di dashboard | Bisa, **saat ini dilewati** | `REQUIRE_APPROVAL=true` untuk mengaktifkan |
| Regime (`src/ops/regime.ts`) | Tidak | Informasi + peringatan Telegram "kurang cocok". Bot tidak berhenti karena regime |
| Lab R&D (`src/ops/lab.ts`) | Tidak | Uji ulang mingguan; hasilnya saran untuk mengubah watchlist secara manual |
| Discover (`src/ops/discover.ts`) | Tidak | Kandidat koin baru, saran saja |
| AI: debat, sentimen, Head Trader (`src/agents/*`, lewat `src/agents/llm.ts`) | Tidak | Sengaja dirancang hanya narasi/penilaian. Head Trader (07:00 & 15:00 WIB) dan debat kandidat mingguan jalan otomatis di `npm run notify` dan dikirim ke Telegram. Sentimen hanya manual (`npm run sentiment`). Desain engine: "tidak ada LLM yang bisa menimpa Risk Engine" |
| Review mingguan, jurnal, equity | Tidak | Evaluasi dan laporan |
| Live vs backtest (`src/ops/livecheck.ts`) | Tidak | Pembanding = backtest parameter yang sama dengan bot (`execution/expectations.json`, diperbarui tiap 7 hari oleh notifier). Laporan Telegram tiap 10 trade live + peringatan kalah beruntun (peluang < 1%). `/live` di Telegram, `npm run livecheck` manual |
| Riset scalping (`src/scalp/`, Ruang Scalping) | Tidak | **Fase 1: riset saja**, tidak ada kode order. `npm run scalp:fetch` (data 5m/15m, koin di luar watchlist) lalu `npm run scalp:test` (walk-forward + fee asli, target 0.5/1/2% harga = ROE 10/20/40% di 20x). Hasil ke `office/scalp/`. Fase 2 (dry run real-time) dan 3 (live kecil) belum dibuat dan butuh persetujuan pemilik |
| Dashboard | Hanya STOP & approval | UI tidak pernah mengirim order (lihat `trading-floor-ui/CLAUDE.md`) |

Jadi: ini **bukan cuma tampilan**. Bot benar-benar trading live. Tapi sebagian besar "ruangan" adalah alat pantau dan evaluasi untuk manusia, blokir berita aktif (120 menit), filter crowd masih mati.

## Konfigurasi (.env engine) yang relevan

Jangan pernah menampilkan, menyalin, atau mengirim isi secret (`BINANCE_*`, `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, dll). Cek keberadaannya saja.

| Variabel | Nilai sekarang | Efek |
|---|---|---|
| `EXEC_MODE` | `live` | Order sungguhan. `dry_run` = simulasi |
| `REQUIRE_APPROVAL` | `false` | Entry otomatis tanpa approval |
| Risk per trade | 10% (aturan umum di `src/risk/engine.ts`); baris watchlist bisa menurunkan lewat `riskPct` (SOL & SUI 1h: 5%) | |
| Maks posisi | 2 per timeframe (4h dan 1h), total 4 | dihitung di `bot.ts` per kunci state. Jatah margin per posisi = 90% equity / 4 (`marginSlots` di `src/risk/engine.ts`) supaya keempatnya muat |
| `EQUITY_SNAPSHOT_MINUTES` | `5` | Catat equity untuk grafik |
| `NEWS_BLACKOUT_MINUTES` | `120` | Blokir entry dekat berita high-impact |
| `CROWD_FILTER` | (kosong = false) | Filter crowd mati |
| `GEMINI_API_KEY` | terisi | AI pakai Gemini free tier (`npm run llm:test` untuk cek) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | terisi | Notifikasi Telegram |

Catatan risiko: `office/RISK-RULES.md` mengizinkan leverage sampai 25x, sementara rencana awal pemilik 5x. Konfirmasi ke pemilik sebelum mengubah aturan risiko.

## File di office/ (kontrak engine ↔ UI)

- `execution/log-YYYY-MM-DD.jsonl`: log bot (`{t, msg}`)
- `execution/state.json`: state bot; mtime = heartbeat (UI menganggap bot hidup kalau ≤ 10 menit)
- `execution/watchlist.json`: daftar trading (manual)
- `execution/equity.jsonl`, `execution/trades.jsonl`: equity & jurnal trade (field `crowd` = konteks saat entry)
- `execution/transfers.jsonl`: deposit/penarikan dari riwayat income Binance (dicatat bot). Semua laporan menormalkan equity dengan file ini supaya transfer tidak terhitung untung/rugi
- `execution/STOP`: kill switch
- `approvals/<id>.json`: approval (UI hanya boleh menulis `status`, `catatanBos`, `decidedAt`)
- `market/calendar.json`, `market/regime.json`, `market/crowd.json`, `market/snapshot.json`
- `lab/*.json`, `reviews/review-<senin>.md|json`, `backtests/` (hasil scan)

## Cara memeriksa apakah semuanya tersambung

```
cd trading-floor-engine
npm run typecheck        # kode engine valid
npm run bot:status       # isi state bot
npm run llm:test         # koneksi AI (Gemini)
npm run crowd            # ambil data crowd sekarang
npm run regime           # hitung regime sekarang
npm run notify:test      # kirim pesan tes Telegram
```
Lalu cek log terbaru di `office/execution/log-<hari ini>.jsonl`: cari "Cek sinyal ... selesai", "konteks crowd", "ditolak", "LIVE entry".

## Aturan kerja untuk Claude

- Bot LIVE dengan uang asli: setiap perubahan pada `src/exec/`, `src/risk/`, `src/strategies/`, atau `.env` harus dijelaskan dan dikonfirmasi ke pemilik dulu. Jangan ubah `EXEC_MODE`.
- Lebih dari satu pihak (termasuk sesi Claude lain) pernah mengubah file engine. Selalu baca versi terbaru file sebelum mengedit; jangan menimpa perubahan orang lain.
- Jalankan `npm run typecheck` (engine) dan `npm run lint` + `npm run build` (ui) setelah mengubah kode.
- Usulan yang membuat AI ikut menentukan entry harus melewati backtest/walk-forward dulu; data crowd Binance (OI, long/short) hanya tersedia ~30 hari sehingga belum bisa di-backtest panjang.
