# Trading Floor Engine

Engine kuant + backtester futures (rule-based, TypeScript) untuk tim agent di **Trading Floor**.
Terinspirasi dari [TradingAgents](https://github.com/TauricResearch/TradingAgents), tapi dibangun ulang untuk futures crypto dengan aturan risiko yang ditegakkan oleh kode.

## Kenapa beda dari TradingAgents

| | TradingAgents | Engine ini |
|---|---|---|
| Pasar | Saham (crypto sebagian) | Futures USDT-M: leverage, funding, likuidasi, min notional |
| Sumber sinyal | LLM menilai dari laporan | Aturan kuant yang lolos walk-forward |
| Manajemen risiko | Debat 3 agent LLM | Risk Engine deterministik; tidak ada agent yang bisa menimpa |
| Stop loss | Opsional | Wajib; entry tanpa SL ditolak |
| Ukuran posisi | Teks dari LLM | Dihitung dari risk % dan jarak stop |
| Backtest | Menilai rating keputusan, bukan akun | Simulasi akun bar-by-bar: fee, slippage, funding, likuidasi, gap |
| Validasi | In-sample | Walk-forward out-of-sample + Monte Carlo + vonis ketat |
| Look-ahead LLM | LLM bisa "ingat" harga masa lalu | Tidak ada LLM di backtest |
| Persetujuan manusia | Tidak ada | Lewat meja approval Trading Floor (`npm run debate`, lihat di bawah) |

## Mulai

```bash
npm install
npm test                 # 27 unit test kasus tepi engine
npm run demo             # scan di data sintetis, tanpa internet

# Data asli dari API publik Binance Futures (tanpa API key)
npm run fetch:all        # BTC + XRP, 4h + 1d, sejak 2020
npm run scan:all         # 5 strategi × 2 aset × 2 TF, walk-forward, laporan ke ./office

npm run fetch:top30      # 30 pair USDT-M paling likuid (by volume 24h), 4h + 1d
npm run scan:top30       # 5 strategi × 30 aset × 2 TF

# PowerShell: beri tanda kutip untuk daftar, mis. --tfs "4h,1d" (tanpa kutip, 1d terbaca sebagai angka 1)
```

Perintah lain:

```bash
npm run backtest -- --symbol BTCUSDT --tf 1d --strategy donchian --param n=40
npm run walkforward -- --symbol XRPUSDT --tf 4h --strategy ema_adx --train-days 365 --test-days 90
npm run scan -- --strategies donchian,trend_long --real-equity 81.01
npm run backtest -- --data ./BTCUSDT_4h.csv --symbol BTCUSDT --tf 4h --strategy ema_trend   # CSV export TextToQuant

npm run fetch -- --symbols all --top 50 --tfs 4h,1d --from 2020-01-01   # top 50 pair by volume
npm run scan -- --symbols all --top 50                                 # tanpa --top: SEMUA pair USDT-M perpetual
```

## Strategi

| id | Ide | Exit |
|---|---|---|
| `ema_trend` | Baseline yang sudah dites di TextToQuant (grade F), untuk pembanding | SL/TP persen tetap |
| `donchian` | Tembus high/low N bar searah EMA200 | Chandelier ATR + channel pendek |
| `ema_adx` | EMA cross hanya saat ADX tinggi (menghindari chop) | Target R tetap, breakeven di +1R |
| `rsi_range` | Mean reversion RSI hanya saat ADX rendah | Target R tetap, keluar kalau tren mulai |
| `trend_long` | Long-only di tren naik, "hold dengan rem" | Chandelier ATR, keluar di bawah EMA200 |

## Aturan realisme backtest

- Sinyal di close bar *i*, entry di open bar *i+1* + slippage 0.02%
- Entry batal kalau open sudah melewati stop
- SL dan TP tersentuh di bar sama → dianggap SL
- Gap melewati SL → keluar di open
- Fee taker 0.05% (entry, stop, exit market), maker 0.02% (TP limit)
- Funding tiap 8 jam dari data Binance; long bayar saat rate positif, short menerima
- Likuidasi isolated margin → margin hilang
- Batas rugi harian 3% (hari WIB) memblokir entry baru

## Risk Engine (`src/risk/engine.ts`)

Dipakai sama persis oleh backtest dan eksekusi live/dry-run. Aturan default (`DEFAULT_RULES`, cuma Bos yang boleh ubah):
risk 1% per trade, **leverage maks 25x**, R:R min 1:2 (strategi target tetap), rugi harian 3%,
maks 2 posisi, stop harus kena sebelum separuh jalan ke harga likuidasi, notional ≥ minimum exchange.

## Output ke Trading Floor

`npm run scan` menulis ke `./office` (ubah lewat `OFFICE_DIR`):

- `office/backtests/scan-<waktu>.md` dan `.json`: laporan lengkap
- `office/agents/tio/status.json`: bubble Tio (Analis Teknikal) di kantor
- `office/agents/lala/CATATAN-LALA.md`: ringkasan ditambahkan
- `office/inbox/raka/<waktu>-lala.json`: pesan ke Head Trader

## Debat bull/bear (`npm run debate`)

Lapisan LLM di atas hasil scan, terinspirasi dari tim Researcher (bull/bear) di TradingAgents —
tapi di sini cuma dipakai untuk menyusun argumen dan rekomendasi, **bukan** menggantikan Risk Engine
yang deterministik. Satu panggilan Claude per kandidat, digrounding hanya pada angka walk-forward +
Monte Carlo + kelayakan equity (tidak ada berita/fundamental yang dikarang).

```bash
# butuh ANTHROPIC_API_KEY (API key Anthropic milikmu sendiri, lihat console.anthropic.com)
export ANTHROPIC_API_KEY=sk-ant-...     # PowerShell: $env:ANTHROPIC_API_KEY = "sk-ant-..."

npm run debate                          # top 5 kandidat "Kandidat paper trading" dari scan terakhir
npm run debate -- --top 10 --all        # 10 kandidat apapun vonisnya, termasuk "Edge tipis"
npm run debate -- --file office/backtests/scan-2026-10-23T11-31-37.json --model claude-haiku-4-5
```

Vonis tiap kandidat (`go_paper` / `watch` / `reject`) ditulis ke `office/debates/debate-<waktu>.md`
dan diusulkan ke `office/inbox/raka/<waktu>-debate.json` — **menunggu approval manusia**, tidak ada
eksekusi otomatis. Default model `claude-opus-5`; ganti ke model lebih murah (mis. `claude-haiku-4-5`)
lewat `--model` atau env `DEBATE_MODEL` kalau mau hemat biaya API saat mendebat banyak kandidat.

## Tim agent Trading Floor (`src/agents/roster.ts`)

6 agent bernama, masing-masing punya `office/agents/<nama>/status.json` (bubble) — dasar untuk kantor
virtual isometrik (Next.js + PixiJS) yang rencananya dibangun di Fase 2:

| Agent | Peran | Ruangan | Sumber |
|---|---|---|---|
| Raka | Head Trader | Ruang Meeting | Laporan otomatis 07:00 & 15:00 WIB (`npm run scheduler`) |
| Tio | Analis Teknikal | Riset | `npm run scan` |
| Sendi | Analis Sentimen | Riset | `npm run sentiment` — funding rate + open interest + (opsional) jadwal event |
| Rini | Risk Manager | Risk Desk | `npm run debate` (vonis go_paper/watch/reject) |
| Eko | Eksekutor | Execution Room | `npm run bot` |
| Lala | Jurnal & Evaluasi | Jurnal | Mencatat semua aktivitas di atas (`CATATAN-LALA.md`), kirim ringkasan ke Raka |

## Bot eksekusi live (`npm run bot`)

Bot 24/7 (persona **Eko si Eksekutor**) yang memakai **strategi dan Risk Engine yang sama persis** dengan backtest ([src/strategies/index.ts](src/strategies/index.ts), [src/risk/engine.ts](src/risk/engine.ts)) — bukan reimplementasi baru. Dirancang supaya bug di bot tidak langsung berarti kerugian tak terbatas:

- **Setiap entry baru WAJIB approval manusia secara default** ([src/exec/approvals.ts](src/exec/approvals.ts)) — sinyal yang lolos Risk Engine ditulis ke `office/approvals/<id>.json` (status `pending`), dicek ulang tiap ~1 menit (tidak blocking simbol lain di watchlist — approve/reject kamu lewat CLI/UI terasa cepat, tidak harus nunggu bar close berikutnya yang bisa berjam-jam untuk TF 4h). Auto-`expired` kalau tidak diputuskan dalam `APPROVAL_TIMEOUT_MINUTES` (default 30 menit). Ini berlaku di `dry_run` DAN `live` — jadi seluruh alur approval bisa dites penuh tanpa risiko uang nyata dulu.
  - **`REQUIRE_APPROVAL=false`** menghapus gerbang ini — entry baru langsung otomatis, tanpa kamu klik apa pun. Ini membalik pengaman yang didesain sejak awal; cuma masuk akal kalau watchlist-nya sudah divalidasi lama di `dry_run` dan kamu benar-benar paham risikonya (termasuk risiko data-dredging dari scan 1000+ kombinasi yang sudah dibahas di laporan debat).
- **Default `EXEC_MODE=dry_run`.** Approval yang disetujui pun cuma dicatat, tidak kirim order asli. Harus eksplisit `EXEC_MODE=live` untuk eksekusi sungguhan.
- **Exit (SL/TP) tetap otomatis**, tidak lewat approval — itu order asli yang sudah duduk di Binance begitu posisi dibuka (STOP_MARKET/TAKE_PROFIT_MARKET, `closePosition: true`). Kalau bot/mesin mati, posisi tetap terlindungi.
- **Kill switch**: `npm run bot:stop` membuat file `office/execution/STOP` — bot berhenti membuka trade baru di tick berikutnya. Posisi yang sudah terbuka tidak otomatis ditutup — keputusan manual lewat Binance langsung, supaya tidak ada exit paksa di harga buruk saat darurat.
- **Watchlist manual** (`office/execution/watchlist.json`) — bot HANYA mentradingkan simbol/strategi yang kamu daftar eksplisit di sana. Tidak otomatis dari hasil scan/debate.
- Batas risiko sama dengan backtest: risk 1%/trade, leverage maks 25x, batas rugi harian 3%, maks 2 posisi — ditegakkan [Risk Engine](src/risk/engine.ts) yang sama, tidak bisa ditimpa bot.
- **Pengaman tambahan hasil review eksekusi**: leverage dari Risk Engine dicek lagi terhadap batas leverage ASLI exchange per simbol (`getLeverageBrackets`) sebelum dikirim; kalau order stop/target gagal terpasang setelah entry berhasil, bot langsung tutup darurat posisi itu (tidak boleh ada posisi tanpa stop); dan tiap tick, posisi yang tercatat dicek ulang ke exchange — kalau sudah tertutup duluan oleh SL/TP, state disinkronkan supaya bot tidak "nyangkut" mengira masih ada posisi terbuka.

```bash
npm run approvals                          # list approval entry yang masih pending
npm run approvals -- --approve <id>        # izinkan
npm run approvals -- --reject <id>         # tolak
```

```bash
cp .env.example .env    # isi BINANCE_API_KEY/SECRET di .env (gitignored) — jangan paste key di chat lagi

npm run bot                        # bikin office/execution/watchlist.example.json kalau belum ada watchlist.json
# salin ke watchlist.json, isi simbol/tf/strategi yang sudah lolos debat, lalu jalankan lagi
npm run bot:status                 # lihat state posisi bot
npm run bot:stop                   # kill switch — berhenti buka trade baru
```

Ada draf kandidat (3 yang sampel-nya paling tebal & DD paling kecil dari scan top100: ADAUSDT ema_adx, ARBUSDT donchian, AAVEUSDT ema_trend) di `office/execution/watchlist.draft.json` — review dulu, baru salin/ubah jadi `watchlist.json` kalau setuju. Bot tidak membaca file `.draft.json` secara otomatis.

Dry-run **tidak butuh API key sama sekali** untuk dites (equity dummy lewat env `DRY_RUN_EQUITY`, default 10000) — API key cuma dibutuhkan untuk baca saldo asli atau untuk `EXEC_MODE=live`.

**Operasional**: ini proses yang harus terus jalan (bukan command sekali-jalan) — PC/servermu harus tetap on, atau deploy ke VPS/server yang jalan 24/7. Belum ada notifikasi (Telegram/email) di v1 — pantau lewat `office/execution/log-<tanggal>.jsonl` dan `bot:status`.

**Sebelum live**: jalankan `EXEC_MODE=dry_run` dulu untuk beberapa hari, baca log-nya, bandingkan sinyal yang muncul dengan ekspektasi dari backtest. Edge yang ditemukan scan masih berasal dari 1000+ kombinasi yang discan sekaligus (risiko data-dredging sudah dibahas di laporan debat) — jalankan `npm run debate` dulu untuk kandidat di watchlist-mu, jangan langsung `EXEC_MODE=live` tanpa validasi tambahan itu.

## Analis Sentimen (`npm run sentiment`)

Funding rate + open interest dari Binance (data asli), narasi dari Claude — grounded ke angka saja,
sama pola dengan `npm run debate`.

```bash
npm run sentiment -- --symbol ADAUSDT
```

Jadwal event crypto (CoinMarketCal) opsional — kalau `COINMARKETCAL_API_KEY` tidak di-set di `.env`,
bagian ini cuma dilewati (funding+OI tetap jalan). Daftar API key gratis di
[coinmarketcal.com/en/apidocument](https://coinmarketcal.com/en/apidocument).

## Head Trader & laporan terjadwal (`npm run scheduler`)

Proses long-running (sama sifatnya dengan `npm run bot` — harus terus jalan) yang memanggil Head
Trader (Raka) sekali tiap jam **07:00 dan 15:00 WIB** untuk meringkas aktivitas scan/debate/bot
terakhir jadi laporan singkat. Ditulis ke `office/reports/<tanggal>-<pagi|sore>.md`, tidak dobel
kirim di hari yang sama (dicek dari keberadaan file laporan hari itu).

```bash
npm run scheduler
```

## Frontend: kantor virtual (`trading-floor-ui`)

UI-nya project terpisah di `C:\Users\user\trading\trading-floor-ui` (Next.js, Canvas 2D isometrik).
Ia hanya membaca `office/` (lewat SSE, real-time) dan cuma boleh menulis status approval dan file
kill switch `execution/STOP`. Tidak pernah mengirim order dan tidak membaca `.env` engine.

```powershell
cd C:\Users\user\trading\trading-floor-ui
npm run dev        # http://localhost:3000
```

Angka di Ruang Bos (equity, leverage maks, risk per trade) diambil dari `execution/state.json` dan
tabel di `office/RISK-RULES.md`, jadi tabel itu harus ikut diperbarui kalau `DEFAULT_RULES` diubah.

## Catatan penting

- Kolom **"Bisa di $81.01"** menunjukkan berapa sinyal yang lolos Risk Engine di equity kamu sekarang. Dengan risk 1%, notional BTC sering di bawah minimum order $100, jadi sinyal BTC hampir semua ditolak. XRP (minimum $5) masih bisa.
- Spesifikasi pasar (`MARKET_SPECS` di `src/types.ts`) adalah perkiraan tier pertama Binance. Cek ulang di exchange sebelum live.
- Vonis "Kandidat paper trading" berarti layak diuji di paper, bukan layak live.
