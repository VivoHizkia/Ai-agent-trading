# Aturan Risiko — Trading Floor

> Dokumen ini adalah penjelasan manusiawi dari aturan yang benar-benar ditegakkan di kode:
> [`src/risk/engine.ts`](../src/risk/engine.ts) (`DEFAULT_RULES`). Kalau dokumen ini dan kode
> beda, **kode yang menang** — dokumen ini cuma referensi baca, bukan sumber kebenaran.
>
> **Hanya Bos (user) yang boleh mengubah angka-angka ini, dan caranya cuma satu: edit
> `DEFAULT_RULES` di `src/risk/engine.ts` langsung.** Tidak ada agent — termasuk Raka,
> Rini/Risk Manager, atau sesi Claude manapun — yang punya akses tulis ke file itu atau
> cara lain untuk melonggarkan aturan ini lewat percakapan. Risk Engine jalan sama persis
> di backtest maupun di bot live (`npm run bot`); tidak ada jalur LLM yang bisa melewatinya.

## Aturan saat ini

| Aturan | Nilai |
|---|---|
| Risk per trade | 10% equity (strategi 1h: 5%, diatur per baris watchlist lewat `riskPct`) |
| Leverage maksimal | 25x |
| Minimum R:R (strategi dengan target tetap) | 1:2 |
| Batas rugi harian | 3% dari equity awal hari → stop trading sampai besok |
| Maks posisi terbuka bersamaan | 2 per timeframe (2 untuk 4h + 2 untuk 1h, total 4) |
| Jatah margin per posisi | Utamakan 90% equity dibagi 4 (keempat posisi muat). Kalau leverage-nya membuat stop terlalu dekat likuidasi, margin dinaikkan sampai 90% dibagi 2 dengan leverage tertinggi yang masih aman. Rugi per trade tetap |
| Jarak stop ke harga likuidasi | stop harus kena dulu — jarak entry→stop maksimal 50% dari jarak entry→likuidasi |
| Stop loss | wajib untuk semua entry, tidak ada pengecualian |

## Kenapa sinyal bisa ditolak (`REJECTION_LABEL` di kode)

- `equity_habis` — Equity habis
- `tanpa_stop` — Tidak ada stop loss
- `stop_salah_sisi` — Stop di sisi yang salah
- `maks_posisi` — Sudah maksimal posisi terbuka
- `batas_rugi_harian` — Batas rugi harian tercapai
- `target_salah_sisi` — Target di sisi yang salah
- `rr_kurang` — R:R di bawah minimum
- `tanpa_target` — Tidak ada target dan bukan strategi trailing
- `stop_terlalu_dekat_likuidasi` — Stop terlalu dekat harga likuidasi
- `di_bawah_min_notional` — Notional di bawah minimum order exchange (umum terjadi di equity kecil + aset mahal)

## Batasan tambahan yang berlaku di luar Risk Engine

- **Hanya `bot.ts` (kode deterministik) yang boleh mengirim order asli ke Binance.** Tidak ada
  agent/LLM yang punya tool untuk memanggil endpoint order secara langsung.
- **Leverage dipotong lagi** ke batas real exchange per simbol/notional lewat
  `clampToExchangeLeverage` (Binance leverage bracket) — bisa lebih rendah dari 25x kalau
  exchange tidak izinkan segitu untuk ukuran posisi tersebut.
- **`REQUIRE_APPROVAL`** (env var di `.env`) menentukan apakah entry baru butuh klik "Izinkan"
  di dashboard dulu sebelum dieksekusi, atau langsung otomatis begitu Risk Engine meloloskan
  sinyal. Exit (stop loss / take profit) **selalu otomatis**, tidak pernah butuh approval —
  itu bukan pengambilan risiko baru, itu cara keluar dari risiko yang sudah ada.
